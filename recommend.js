/* Progress Menu 推荐引擎移植（源自 scripts/recommend.lua, pool.lua, state.lua, config.lua）
 * 数据来自 window.PROGRESS_DATA（见 data.js）
 * 网页端无 Isaac Lua API，进度（已解锁成就）由存档解析提供。
 */
(function () {
  "use strict";

  /* ===== Config ===== */
  var Config = {
    DifficultyNames: { 1: "简单", 2: "简单-中等", 3: "中等", 4: "中等-困难", 5: "困难", 6: "极难" },
    DifficultyPenalty: { 1: 0, 2: 0.25, 3: 0.70, 4: 1.20, 5: 1.90, 6: 2.80 },
    Defaults: {
      enabledDifficulties: { 1: true, 2: true, 3: true, 4: false, 5: false, 6: false },
      enabledQualities: { 0: true, 1: true, 2: true, 3: true, 4: true },
      enabledTrinkets: true,
      enabledNonItems: true,
      topN: 641,
      showLocked: false,
      preferRoutes: true
    }
  };

  /* ===== 池模型常量 ===== */
  var Q_BASELINE = { 0: 2.0, 1: 3.6, 2: 5.7, 3: 7.5, 4: 9.4 };
  var CORE = {
    treasure: true, shop: true, devil: true, angel: true, boss: true, secret: true,
    curse: true, library: true, planetarium: true, redChest: true, goldenChest: true,
    momsChest: true, oldChest: true, ultraSecret: true
  };

  function contains(list, v) {
    if (!list) return false;
    for (var i = 0; i < list.length; i++) if (list[i] === v) return true;
    return false;
  }

  /* ===== State（设置 + 进度，简化自 state.lua）===== */
  function State() {
    this.settings = {
      enabledDifficulties: Object.assign({}, Config.Defaults.enabledDifficulties),
      enabledQualities: Object.assign({}, Config.Defaults.enabledQualities),
      enabledTrinkets: Config.Defaults.enabledTrinkets,
      enabledNonItems: Config.Defaults.enabledNonItems,
      topN: Config.Defaults.topN,
      showLocked: Config.Defaults.showLocked,
      preferRoutes: Config.Defaults.preferRoutes
    };
    this.knownUnlocked = {};   // achievement id -> true
    this.transientIgnored = {}; // 会话级忽略
    this.progressVersion = 1;
    this.settingsVersion = 1;
  }
  State.prototype = {
    setUnlocked: function (map) {
      this.knownUnlocked = map || {};
      this.progressVersion++;
    },
    IsAchievementUnlocked: function (id) {
      if (id == null || id <= 0) return true;
      return this.knownUnlocked[id] === true || this.knownUnlocked[String(id)] === true;
    },
    IsIgnored: function (id) { return this.transientIgnored[String(id)] === true; },
    SetIgnored: function (id, v) {
      this.transientIgnored[String(id)] = v === true || undefined;
      this.settingsVersion++;
    },
    ClearIgnored: function () {
      if (!Object.keys(this.transientIgnored).length) return false;
      this.transientIgnored = {};
      this.settingsVersion++;
      return true;
    },
    IsDifficultyEnabled: function (v) {
      v = Math.max(1, Math.min(6, Number(v) || 3));
      return this.settings.enabledDifficulties[v] === true;
    },
    SetDifficultyEnabled: function (v, en) {
      v = Math.max(1, Math.min(6, Number(v) || 3));
      this.settings.enabledDifficulties[v] = en === true;
      this.settingsVersion++;
    },
    ToggleDifficulty: function (v) { this.SetDifficultyEnabled(v, !this.IsDifficultyEnabled(v)); },
    IsQualityEnabled: function (q) {
      q = Math.max(0, Math.min(4, Math.floor(Number(q) || 0)));
      return this.settings.enabledQualities[q] !== false;
    },
    SetQualityEnabled: function (q, en) {
      q = Math.max(0, Math.min(4, Math.floor(Number(q) || 0)));
      this.settings.enabledQualities[q] = en === true;
      this.settingsVersion++;
    },
    ToggleQuality: function (q) { this.SetQualityEnabled(q, !this.IsQualityEnabled(q)); },
    IsTrinketsEnabled: function () { return this.settings.enabledTrinkets !== false; },
    ToggleTrinkets: function () { this.settings.enabledTrinkets = !this.IsTrinketsEnabled(); this.settingsVersion++; },
    IsNonItemsEnabled: function () { return this.settings.enabledNonItems !== false; },
    ToggleNonItems: function () { this.settings.enabledNonItems = !this.IsNonItemsEnabled(); this.settingsVersion++; },
    IsShowLockedEnabled: function () { return this.settings.showLocked === true; },
    ToggleShowLocked: function () { this.settings.showLocked = !this.IsShowLockedEnabled(); this.settingsVersion++; },
    QualitySummary: function () {
      var names = [];
      for (var q = 0; q <= 4; q++) if (this.IsQualityEnabled(q)) names.push(q + "级");
      return names.length ? names.join(", ") : "无";
    },
    DifficultySummary: function () {
      var names = [];
      for (var i = 1; i <= 6; i++) if (this.IsDifficultyEnabled(i)) names.push(Config.DifficultyNames[i]);
      return names.length ? names.join(", ") : "无";
    }
  };

  /* ===== Pool（池模型，源自 pool.lua）===== */
  function Pool(state, tasks) {
    this.state = state;
    this.tasks = tasks;
    this.itemValues = window.PROGRESS_DATA.itemValues || {};
    this.itemQualities = window.PROGRESS_DATA.itemQualities || {};
    this.poolData = window.PROGRESS_DATA.pools || {};

    // byAchievement：成就 -> 任务
    this.byAchievement = {};
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].achievement) this.byAchievement[tasks[i].achievement] = tasks[i];
    }

    // 默认饰品平均（无观察数据时的基线）
    var tsum = 0, tn = 0;
    for (var j = 0; j < tasks.length; j++) {
      if (tasks[j].rewardKind === "trinket") { tsum += (tasks[j].value || 5); tn++; }
    }
    this.defaultTrinketAverage = tn > 0 ? (tsum / tn) : 5.0;

    // poolMemberships：collectible id -> [{name, weight}]
    this.poolMemberships = {};
    var ids = {};
    for (var poolName in this.poolData) {
      var entries = this.poolData[poolName] || [];
      for (var k = 0; k < entries.length; k++) {
        var id = Math.floor(Number(entries[k][0]) || -1);
        if (id > 0) {
          ids[id] = true;
          if (!this.poolMemberships[id]) this.poolMemberships[id] = [];
          this.poolMemberships[id].push({ name: poolName, weight: Number(entries[k][1]) || 1 });
        }
      }
    }
    this.cacheVersion = -1;
    this.cache = { sum: 0, weight: 0, count: 0, average: 0, pools: {}, tiers: {}, trinkets: { sum: 0, count: 0, average: this.defaultTrinketAverage } };
  }
  Pool.prototype = {
    ItemScore: function (id) {
      var v = this.itemValues[id];
      if (v != null) return v;
      var q = this.ItemQuality(id);
      if (q != null && Q_BASELINE[q] != null) return Q_BASELINE[q];
      return 5;
    },
    ItemQuality: function (id) {
      var q = this.itemQualities[id];
      if (q == null) return null;
      q = Number(q);
      if (q >= 0 && q <= 4) return Math.floor(q);
      return null;
    },
    // 道具是否已解锁（网页端：通过成就集合判断，兼容已知成就）
    IsUnlockedByAchievement: function (achievementId) {
      if (achievementId == null || achievementId <= 0) return true;
      return this.state.IsAchievementUnlocked(achievementId);
    },
    GetTaskQuality: function (task) {
      if (!task || task.rewardKind !== "collectible") return task && task.staticQuality;
      var rewards = task.rewards || [];
      for (var i = 0; i < rewards.length; i++) {
        var rw = rewards[i];
        if (rw.kind === "collectible") {
          var q = this.ItemQuality(rw.id);
          if (q != null) return q;
        }
      }
      var sq = Number(task.staticQuality);
      return (sq != null && !isNaN(sq)) ? Math.floor(sq) : null;
    },
    // 用"任务成就已解锁"来判断道具是否解锁（网页端无 ItemConfig）
    TaskUnlocked: function (task) {
      return this.state.IsAchievementUnlocked(task.achievement);
    },
    RebuildIfNeeded: function () {
      if (this.cacheVersion === this.state.progressVersion) return this.cache;
      var r = { sum: 0, weight: 0, count: 0, average: 0, pools: {}, seen: {}, tiers: {}, trinkets: { sum: 0, count: 0, average: this.defaultTrinketAverage } };
      for (var q = 0; q <= 4; q++) r.tiers[q] = { sum: 0, weight: 0, count: 0, average: Q_BASELINE[q] };

      var self = this;
      // 每个 collectible 的解锁状态：由其对应成就（任务）决定
      // 建立 collectible id -> achievement id 的映射（从任务的 rewards）
      var collectibleAchievement = {};
      for (var ti = 0; ti < this.tasks.length; ti++) {
        var t = this.tasks[ti];
        if (t.rewardKind === "collectible" && t.rewards) {
          for (var ri = 0; ri < t.rewards.length; ri++) {
            if (t.rewards[ri].kind === "collectible") {
              collectibleAchievement[t.rewards[ri].id] = t.achievement;
            }
          }
        }
      }
      function unlockedCollectible(id) {
        var ach = collectibleAchievement[id];
        if (ach != null) return self.state.IsAchievementUnlocked(ach);
        // 无对应任务成就的道具（如基础道具），视为已解锁
        return true;
      }

      // 加权核心池分数
      for (var name in this.poolData) {
        var entries = this.poolData[name] || [];
        var sum = 0, wt = 0, count = 0;
        for (var e = 0; e < entries.length; e++) {
          var cid = Math.floor(Number(entries[e][0]) || -1);
          var w = Number(entries[e][1]) || 1;
          if (unlockedCollectible(cid)) {
            var v = self.ItemScore(cid);
            sum += v * w; wt += w; count++; r.seen[cid] = true;
            if (CORE[name]) { r.sum += v * w; r.weight += w; }
          }
        }
        r.pools[name] = { sum: sum, weight: wt, count: count, average: wt > 0 ? sum / wt : 0 };
      }
      for (var _ in r.seen) r.count++;
      r.average = r.weight > 0 ? r.sum / r.weight : 0;

      // 每品质层级的算术平均（用户可见的 Q0-Q4 平均值）
      for (var q2 = 0; q2 <= 4; q2++) r.tiers[q2] = { sum: 0, weight: 0, count: 0, average: Q_BASELINE[q2], observedAverage: null };
      for (var iid in this.itemValues) {
        var ii = Math.floor(Number(iid) || -1);
        if (ii < 1) continue;
        if (!unlockedCollectible(ii)) continue;
        var qq = this.ItemQuality(ii);
        if (qq != null && r.tiers[qq]) {
          var tt = r.tiers[qq];
          tt.sum += this.ItemScore(ii);
          tt.count++;
        }
      }
      for (var q3 = 0; q3 <= 4; q3++) {
        var tt2 = r.tiers[q3];
        tt2.weight = tt2.count;
        if (tt2.count > 0) {
          tt2.observedAverage = tt2.sum / tt2.count;
          tt2.average = tt2.observedAverage;
        } else {
          tt2.average = Q_BASELINE[q3];
        }
      }

      // 饰品平均（独立类别）
      var seenTrinkets = {};
      for (var tt3 = 0; tt3 < this.tasks.length; tt3++) {
        var t3 = this.tasks[tt3];
        if (t3.rewardKind === "trinket" && t3.rewards) {
          for (var r3 = 0; r3 < t3.rewards.length; r3++) {
            var rw3 = t3.rewards[r3];
            if (rw3.kind === "trinket" && !seenTrinkets[rw3.id] && this.state.IsAchievementUnlocked(t3.achievement)) {
              seenTrinkets[rw3.id] = true;
              r.trinkets.sum += (t3.value || 5);
              r.trinkets.count++;
            }
          }
        }
      }
      if (r.trinkets.count > 0) r.trinkets.average = r.trinkets.sum / r.trinkets.count;

      this.cache = r;
      this.cacheVersion = this.state.progressVersion;
      return r;
    },
    GetAverage: function () { return this.RebuildIfNeeded().average; },
    GetTierAverage: function (q) {
      q = Math.max(0, Math.min(4, Math.floor(Number(q) || 0)));
      var t = this.RebuildIfNeeded().tiers[q];
      return t ? t.average : Q_BASELINE[q];
    },
    GetTierAverages: function () { return this.RebuildIfNeeded().tiers; },
    GetTrinketAverage: function () { return this.RebuildIfNeeded().trinkets.average; },
    GetTrinketStats: function () { return this.RebuildIfNeeded().trinkets; },

    IsRouteTaskAboveOwnedAverage: function (task) {
      if (!task) return true;
      var rewards = task.rewards || [];
      for (var i = 0; i < rewards.length; i++) {
        var rw = rewards[i];
        if (rw.kind === "collectible") {
          var q = this.ItemQuality(rw.id);
          if (q == null) q = Number(rw.quality);
          if (q == null) q = Number(task.staticQuality);
          if (q != null && q >= 0 && q <= 4) {
            q = Math.floor(q);
            var stats = this.GetTierAverages()[q];
            if (stats && stats.count > 0 && stats.observedAverage != null) {
              var value = this.ItemScore(rw.id);
              if (value <= stats.observedAverage) return false;
            }
          }
        } else if (rw.kind === "trinket") {
          var ts = this.GetTrinketStats();
          if (ts && ts.count > 0 && (task.value || 5) <= ts.average) return false;
        }
      }
      return true;
    },

    CandidateImpact: function (c) {
      var base = this.RebuildIfNeeded();
      var ids = {}, scores = {};
      var collectibleN = 0, vsum = 0, qsum = 0;
      var comparableN = 0, relativeLiftSum = 0;
      var comparisons = [];
      var trinketIds = {};
      var trinketN = 0, trinketValueSum = 0, trinketLiftSum = 0;
      var ownedBaselineN = 0;

      var tasks = c.tasks || [];
      for (var ti = 0; ti < tasks.length; ti++) {
        var t = tasks[ti];
        if (this.state.IsAchievementUnlocked(t.achievement)) continue;
        var rewards = t.rewards || [];
        for (var ri = 0; ri < rewards.length; ri++) {
          var rw = rewards[ri];
          if (rw.kind === "collectible" && !ids[rw.id]) {
            var score = this.ItemScore(rw.id);
            var q = this.ItemQuality(rw.id);
            var tierAvg = (q != null && base.tiers[q] && base.tiers[q].average) || score;
            var baselineOwned = q != null && base.tiers[q] && base.tiers[q].count > 0 && base.tiers[q].observedAverage != null;
            var lift = score - tierAvg;
            ids[rw.id] = true; scores[rw.id] = score;
            collectibleN++; vsum += score;
            if (q != null) qsum += q;
            comparableN++; relativeLiftSum += lift;
            if (baselineOwned) ownedBaselineN++;
            comparisons.push({ kind: "collectible", id: rw.id, quality: q, score: score, baseline: tierAvg, lift: lift, baselineOwned: baselineOwned });
          } else if (rw.kind === "trinket" && !trinketIds[rw.id]) {
            trinketIds[rw.id] = true;
            var tscore = t.value || 5;
            var tbaseline = base.trinkets.average || this.defaultTrinketAverage;
            var tbaselineOwned = base.trinkets.count > 0;
            var tlift = tscore - tbaseline;
            trinketN++; trinketValueSum += tscore; trinketLiftSum += tlift;
            comparableN++; relativeLiftSum += tlift;
            if (tbaselineOwned) ownedBaselineN++;
            comparisons.push({ kind: "trinket", id: rw.id, score: tscore, baseline: tbaseline, lift: tlift, baselineOwned: tbaselineOwned });
          }
        }
      }
      if (comparableN === 0) return null;

      var addSum = 0, addWt = 0;
      var bestName = null, bestWt = 0, beforePool = 0, afterPool = 0;
      var additions = {};
      for (var id in ids) {
        var memberships = this.poolMemberships[id] || [];
        for (var mi = 0; mi < memberships.length; mi++) {
          var name = memberships[mi].name, weight = memberships[mi].weight;
          if (!additions[name]) additions[name] = { sum: 0, weight: 0 };
          additions[name].sum += (scores[id] || this.ItemScore(id) || 5) * weight;
          additions[name].weight += weight;
        }
      }
      for (var an in additions) {
        var a = additions[an];
        if (CORE[an]) { addSum += a.sum; addWt += a.weight; }
        if (a.weight > bestWt) {
          var p = base.pools[an] || { sum: 0, weight: 0, average: 0 };
          bestName = an; bestWt = a.weight; beforePool = p.average;
          afterPool = (p.sum + a.sum) / (p.weight + a.weight);
        }
      }
      var after = addWt > 0 ? (base.sum + addSum) / (base.weight + addWt) : base.average;

      return {
        before: base.average, after: after, delta: after - base.average,
        added: collectibleN,
        addedAverage: collectibleN > 0 ? vsum / collectibleN : null,
        averageQuality: collectibleN > 0 ? qsum / collectibleN : null,
        trinketAdded: trinketN,
        trinketAverage: trinketN > 0 ? trinketValueSum / trinketN : null,
        trinketBaseline: base.trinkets.average,
        trinketObservedCount: base.trinkets.count || 0,
        trinketLiftAverage: trinketN > 0 ? trinketLiftSum / trinketN : null,
        tierLiftAverage: relativeLiftSum / comparableN,
        ownedBaselineCount: ownedBaselineN,
        tierComparisons: comparisons,
        poolName: bestName, poolBefore: beforePool, poolAfter: afterPool, poolDelta: afterPool - beforePool
      };
    }
  };

  /* ===== Recommend（推荐逻辑，源自 recommend.lua）===== */
  var PLAYER_ALIASES = [
    ["PLAYER_LAZARUS2", "PLAYER_LAZARUS"],
    ["PLAYER_THESOUL", "PLAYER_THEFORGOTTEN"],
    ["PLAYER_LAZARUS2_B", "PLAYER_LAZARUS_B"],
    ["PLAYER_THESOUL_B", "PLAYER_THEFORGOTTEN_B"],
    ["PLAYER_ESAU", "PLAYER_JACOB"],
    ["PLAYER_ESAU_B", "PLAYER_JACOB_B"]
  ];
  function canonicalPlayer(pt) {
    if (pt == null) return pt;
    for (var i = 0; i < PLAYER_ALIASES.length; i++) {
      if (pt === PLAYER_ALIASES[i][0]) return PLAYER_ALIASES[i][1];
    }
    return pt;
  }
  function isChallengeGateTask(t) {
    if (!t) return false;
    if (t.rewardKind === "challenge") return true;
    if (t.rewardKind !== "feature") return false;
    return (t.requirement || "").indexOf("unlocks Challenge") !== -1;
  }
  function isObservableTask(t) {
    if (!t) return false;
    var kind = t.rewardKind;
    return kind === "collectible" || kind === "trinket" || kind === "card" || kind === "rune" || kind === "pill" || kind === "feature";
  }

  function Recommend(tasks, routes, state, pool, allTasks) {
    this.tasks = tasks;
    this.allTasks = allTasks || tasks;
    this.routes = routes || [];
    this.state = state;
    this.pool = pool;
    this.byId = {};
    this.byAchievement = {};
    this.allByAchievement = {};
    this.challengeGates = {};
    this.characterBest = {};
    this.challengeBest = {};
    this.dependentsByAchievement = {};

    for (var i = 0; i < this.allTasks.length; i++) {
      var t = this.allTasks[i];
      if (t.achievement) this.allByAchievement[t.achievement] = t;
      if (isChallengeGateTask(t) && t.achievement) this.challengeGates[t.achievement] = t;
    }
    for (var j = 0; j < tasks.length; j++) {
      var tt = tasks[j];
      this.byId[tt.id] = tt;
      if (tt.achievement) this.byAchievement[tt.achievement] = tt;
      var prereq = tt.prereq || [];
      for (var p = 0; p < prereq.length; p++) {
        if (!this.dependentsByAchievement[prereq[p]]) this.dependentsByAchievement[prereq[p]] = [];
        this.dependentsByAchievement[prereq[p]].push(tt);
      }
    }
    // 角色解锁价值 = 该角色后续可解锁的最佳 collectible 价值
    for (var c = 0; c < tasks.length; c++) {
      var tc = tasks[c];
      if (tc.rewardKind === "collectible" && tc.playerEnum) {
        var v = tc.value || 5;
        var prev = this.characterBest[tc.playerEnum];
        if (!prev || v > prev.value) this.characterBest[tc.playerEnum] = { value: v, reward: tc.reward };
      }
    }
    // 挑战门价值 = 最佳实际奖励
    for (var g = 0; g < tasks.length; g++) {
      var tg = tasks[g];
      if (!isChallengeGateTask(tg) && tg.recommendable !== false) {
        var p2 = tg.prereq || [];
        for (var a = 0; a < p2.length; a++) {
          if (this.challengeGates[p2[a]]) {
            var v2 = tg.value || 5;
            var prev2 = this.challengeBest[p2[a]];
            if (!prev2 || v2 > prev2.value) this.challengeBest[p2[a]] = { value: v2, reward: tg.reward };
          }
        }
      }
    }
    this.cacheKey = "";
    this.cache = [];
    this.countCacheKey = "";
    this.countCacheAvailable = 0;
    this.countCacheTotal = 0;
  }
  Recommend.prototype = {
    EffectiveValue: function (t) {
      if (!t) return 5;
      if (t.rewardKind === "character" && t.rewardPlayerEnum) {
        var best = this.characterBest[t.rewardPlayerEnum];
        if (best) return best.value;
      }
      if (isChallengeGateTask(t) && t.achievement) {
        var best2 = this.challengeBest[t.achievement];
        if (best2) return best2.value;
      }
      return t.value || 5;
    },
    ValueBasis: function (t) {
      if (!t) return null;
      if (t.rewardKind === "character" && t.rewardPlayerEnum) {
        var best = this.characterBest[t.rewardPlayerEnum];
        if (best) return { reward: best.reward, kind: "character" };
      }
      if (isChallengeGateTask(t) && t.achievement) {
        var best2 = this.challengeBest[t.achievement];
        if (best2) return { reward: best2.reward, kind: "challenge" };
      }
      return null;
    },
    IsComplete: function (t) {
      if (t.achievement && this.state.IsAchievementUnlocked(t.achievement)) return true;
      return false;
    },
    GetChallengeGate: function (t) {
      var prereq = (t && t.prereq) || [];
      for (var i = 0; i < prereq.length; i++) {
        if (this.challengeGates[prereq[i]]) return this.challengeGates[prereq[i]];
      }
      return null;
    },
    PrereqsSatisfied: function (t, virtual) {
      var prereq = (t && t.prereq) || [];
      for (var i = 0; i < prereq.length; i++) {
        var a = prereq[i];
        if ((virtual && virtual[a]) || this.state.IsAchievementUnlocked(a)) continue;
        return false;
      }
      return true;
    },
    EffectiveRequirement: function (t) {
      var req = t.requirement || t.reward || "无说明。";
      var notes = [], seen = {};
      var prereq = (t.prereq || []);
      for (var i = 0; i < prereq.length; i++) {
        var a = prereq[i];
        if (!this.state.IsAchievementUnlocked(a)) {
          var prerequisite = this.allByAchievement[a];
          if (prerequisite && !isObservableTask(prerequisite)) {
            var label = prerequisite.reward || ("成就 " + a);
            var instruction = prerequisite.requirement || "完成其解锁要求。";
            var note = "若 " + label + " 仍未解锁：" + instruction;
            if (!seen[note]) { seen[note] = true; notes.push(note); }
          }
        }
      }
      if (notes.length > 0) return req + " " + notes.join(" ");
      return req;
    },
    EffectiveDifficulty: function (t) {
      var d = t.difficulty || 3;
      var gate = this.GetChallengeGate(t);
      if (gate && !this.state.IsAchievementUnlocked(gate.achievement)) d = Math.max(d, gate.difficulty || d);
      return d;
    },
    MissingPrerequisites: function (t, virtual) {
      var out = [], seen = {};
      var self = this;
      function add(label) {
        label = String(label == null ? "未知前置" : label);
        if (!seen[label]) { seen[label] = true; out.push(label); }
      }
      function inspect(a) {
        if ((virtual && virtual[a]) || self.state.IsAchievementUnlocked(a)) return;
        var pre = self.allByAchievement[a];
        add(pre ? pre.reward : ("成就 " + a));
      }
      var prereq = (t && t.prereq) || [];
      for (var i = 0; i < prereq.length; i++) inspect(prereq[i]);
      return out;
    },
    GetTaskCounts: function (playerType) {
      var cacheKey = (this.state.progressVersion || 0) + ":" + (this.state.settingsVersion || 0) + ":" + playerType;
      if (cacheKey === this.countCacheKey) return [this.countCacheAvailable, this.countCacheTotal];
      var available = 0, total = 0;
      for (var i = 0; i < this.tasks.length; i++) {
        var t = this.tasks[i];
        if (isChallengeGateTask(t) || t.recommendable === false || this.IsComplete(t) || this.state.IsIgnored(t.id)) continue;
        var difficulty = this.EffectiveDifficulty(t);
        var playerOkay = true;
        if (playerType != null) {
          playerOkay = false;
          if (t.playerEnum) {
            playerOkay = canonicalPlayer(t.playerEnum) === canonicalPlayer(playerType);
          }
        }
        if (playerOkay && this.IsTaskFilterAllowed(t)) {
          var isAvail = this.PrereqsSatisfied(t);
          // 可用项受难度筛选；锁定项不受难度筛选
          if (isAvail && !this.state.IsDifficultyEnabled(difficulty)) continue;
          total++;
          if (isAvail) available++;
        }
      }
      this.countCacheKey = cacheKey;
      this.countCacheAvailable = available;
      this.countCacheTotal = total;
      return [available, total];
    },
    DependencyBonus: function (t) {
      if (!t.achievement) return 0;
      var bonus = 0;
      var children = this.dependentsByAchievement[t.achievement] || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        var difficulty = this.EffectiveDifficulty(child);
        var virtual = {}; virtual[t.achievement] = true;
        if (child.recommendable !== false
          && !isChallengeGateTask(child)
          && !this.IsComplete(child)
          && contains(child.prereq, t.achievement)
          && this.state.IsDifficultyEnabled(difficulty)
          && this.IsTaskFilterAllowed(child)
          && this.PrereqsSatisfied(child, virtual)) {
          var childValue = this.EffectiveValue(child);
          bonus += Math.max(0, childValue - 5.5) * 0.10;
        }
      }
      return Math.min(1.50, bonus);
    },
    BaseTaskScore: function (t, difficulty) {
      var d = difficulty || t.difficulty || 3;
      var value = this.EffectiveValue(t);
      return value + this.DependencyBonus(t) - (Config.DifficultyPenalty[d] || 0);
    },
    StandaloneScoreForTask: function (t, difficulty) {
      var score = this.BaseTaskScore(t, difficulty);
      if (this.pool) {
        var impact = this.pool.CandidateImpact({ kind: "task", tasks: [t] });
        if (impact) {
          var lift = impact.tierLiftAverage || 0;
          score += Math.max(-1.0, Math.min(1.0, lift * 0.45));
        }
      }
      return score;
    },
    TaskCategory: function (t) {
      if (t && t.rewardKind === "collectible") return "collectible";
      if (t && t.rewardKind === "trinket") return "trinket";
      return "nonitem";
    },
    IsTaskFilterAllowed: function (t) {
      var category = this.TaskCategory(t);
      if (category === "collectible") {
        var q = this.pool ? this.pool.GetTaskQuality(t) : null;
        if (q == null) q = Number(t.staticQuality);
        if (q == null || q < 0 || q > 4) return true;
        return this.state.IsQualityEnabled(q);
      } else if (category === "trinket") {
        return this.state.IsTrinketsEnabled();
      }
      return this.state.IsNonItemsEnabled();
    },
    ApplyRelativePoolScore: function (c, maxBonus) {
      c.poolImpact = this.pool ? this.pool.CandidateImpact(c) : null;
      if (!c.poolImpact) return c;
      var lift = c.poolImpact.tierLiftAverage || 0;
      var cap = maxBonus || 1.0;
      c.tierPoolBonus = Math.max(-cap, Math.min(cap, lift * 0.45));
      c.score = c.score + c.tierPoolBonus;
      return c;
    },
    TaskCandidate: function (t, includeLocked) {
      if (isChallengeGateTask(t)) return null;
      if (t.recommendable === false || this.IsComplete(t) || this.state.IsIgnored(t.id)) return null;
      var difficulty = this.EffectiveDifficulty(t);
      var available = this.PrereqsSatisfied(t);
      // 可用项受难度筛选；锁定项（未来解锁）不受当前难度偏好限制
      if (available && !this.state.IsDifficultyEnabled(difficulty)) return null;
      if (!this.IsTaskFilterAllowed(t)) return null;
      if (!available && !includeLocked) return null;
      var effectiveValue = this.EffectiveValue(t);
      var liveQuality = this.pool ? this.pool.GetTaskQuality(t) : null;
      if (liveQuality == null) liveQuality = t.staticQuality;
      var basis = this.ValueBasis(t);
      var c = {
        kind: "task", id: t.id, label: t.reward, requirement: this.EffectiveRequirement(t), reward: t.reward,
        rewardKind: t.rewardKind, difficulty: difficulty, value: effectiveValue, staticQuality: liveQuality,
        score: this.BaseTaskScore(t, difficulty), available: available,
        playerEnum: t.playerEnum, playerName: t.playerName, target: t.target, taskIds: [t.id], tasks: [t],
        valueBasisReward: basis ? basis.reward : null, valueBasisKind: basis ? basis.kind : null,
        missingPrereqs: available ? [] : this.MissingPrerequisites(t)
      };
      c.averageQuality = (t.rewardKind === "collectible" && Number(liveQuality) != null && Number(liveQuality) >= 0) ? Number(liveQuality) : null;
      return this.ApplyRelativePoolScore(c, 1.0);
    },
    RouteCandidate: function (route) {
      if (this.state.IsIgnored("route:" + (route && route.id || ""))) return null;
      var virtual = {}, incomplete = [];
      var routeDifficulty = route.difficulty || 3;
      var taskIds = route.taskIds || [];
      for (var i = 0; i < taskIds.length; i++) {
        var t = this.byId[taskIds[i]];
        if (!t) return null;
        if (!this.IsComplete(t)) {
          if (isChallengeGateTask(t) || t.recommendable === false || this.state.IsIgnored(t.id) || !this.PrereqsSatisfied(t, virtual)) return null;
          if (!this.IsTaskFilterAllowed(t)) return null;
          incomplete.push(t);
          routeDifficulty = Math.max(routeDifficulty, t.difficulty || 1);
          if (t.achievement) virtual[t.achievement] = true;
        }
      }
      if (incomplete.length < 2) return null;
      if (!this.state.IsDifficultyEnabled(routeDifficulty)) return null;
      if (this.pool && this.pool.IsRouteTaskAboveOwnedAverage) {
        for (var k = 0; k < incomplete.length; k++) {
          if (!this.pool.IsRouteTaskAboveOwnedAverage(incomplete[k])) return null;
        }
      }
      var finalTask = incomplete[incomplete.length - 1];
      var finalValue = this.EffectiveValue(finalTask);
      var finalQuality = this.pool ? this.pool.GetTaskQuality(finalTask) : null;
      if (finalQuality == null) finalQuality = finalTask.staticQuality;
      for (var m = 0; m < incomplete.length - 1; m++) {
        if (this.EffectiveValue(incomplete[m]) > finalValue) return null;
      }
      var c = {
        kind: "route", id: route.id, label: route.label, requirement: route.note || route.label,
        difficulty: routeDifficulty, value: finalValue,
        score: this.StandaloneScoreForTask(finalTask, routeDifficulty),
        available: true, playerEnum: route.playerEnum, target: route.label, taskIds: [], tasks: incomplete,
        rewardKind: finalTask.rewardKind, staticQuality: finalQuality, finalTaskId: finalTask.id
      };
      var names = [];
      c.routeRewards = [];
      for (var r = 0; r < incomplete.length; r++) {
        var t2 = incomplete[r];
        names.push(t2.reward);
        var objective = (t2.target ? (t2.target + " → ") : "");
        c.routeRewards.push({
          text: objective + (t2.reward || "未知奖励"),
          quality: (t2.rewardKind === "collectible") ? ((this.pool && this.pool.GetTaskQuality(t2)) || t2.staticQuality) : null,
          value: this.EffectiveValue(t2),
          rewardKind: t2.rewardKind,
          reward: t2.reward,
          target: t2.target
        });
        c.taskIds.push(t2.id);
        if (!c.playerName && t2.playerName) c.playerName = t2.playerName;
      }
      c.reward = names.join(" + ");
      c.poolImpact = null;
      c.tierPoolBonus = 0;
      return c;
    },
    GetCandidates: function () {
      var key = [this.state.progressVersion, this.state.settingsVersion,
        this.state.settings.showLocked ? 1 : 0, this.state.settings.preferRoutes ? 1 : 0].join(":");
      if (key === this.cacheKey) return this.cache;
      var includeLocked = this.state.settings.showLocked === true;
      var out = [], covered = {};
      if (this.state.settings.preferRoutes) {
        for (var r = 0; r < this.routes.length; r++) {
          var rc = this.RouteCandidate(this.routes[r]);
          if (rc) {
            out.push(rc);
            for (var ri = 0; ri < rc.taskIds.length; ri++) covered[rc.taskIds[ri]] = true;
          }
        }
      }
      for (var t = 0; t < this.tasks.length; t++) {
        var tc = this.TaskCandidate(this.tasks[t], includeLocked);
        if (tc && !covered[tc.id]) out.push(tc);
      }
      out.sort(function (a, b) {
        if (a.score === b.score) {
          if (a.value === b.value) return a.difficulty - b.difficulty;
          return b.value - a.value;
        }
        return b.score - a.score;
      });
      this.cacheKey = key;
      this.cache = out;
      return out;
    },
    GetTop: function (n) {
      var a = this.GetCandidates();
      var o = [];
      var limit = Math.min(n || this.state.settings.topN, a.length);
      for (var i = 0; i < limit; i++) o.push(a[i]);
      return o;
    },
    GetCandidatesForPlayerType: function (pt) {
      var out = [];
      var a = this.GetCandidates();
      for (var i = 0; i < a.length; i++) {
        var c = a[i];
        if (pt == null || !c || !c.playerEnum) continue;
        if (canonicalPlayer(c.playerEnum) === canonicalPlayer(pt)) out.push(c);
      }
      return out;
    }
  };

  /* ===== 角色枚举（用于角色筛选 UI）===== */
  var PLAYERS = [
    { enum: "PLAYER_ISAAC", name: "以撒" },
    { enum: "PLAYER_MAGDALENE", name: "抹大拉" },
    { enum: "PLAYER_CAIN", name: "该隐" },
    { enum: "PLAYER_JUDAS", name: "犹大" },
    { enum: "PLAYER_BLUEBABY", name: "？？？" },
    { enum: "PLAYER_EVE", name: "夏娃" },
    { enum: "PLAYER_SAMSON", name: "参孙" },
    { enum: "PLAYER_AZAZEL", name: "阿撒泻勒" },
    { enum: "PLAYER_LAZARUS", name: "拉撒路" },
    { enum: "PLAYER_EDEN", name: "伊甸" },
    { enum: "PLAYER_THELOST", name: "游魂" },
    { enum: "PLAYER_LILITH", name: "莉莉丝" },
    { enum: "PLAYER_KEEPER", name: "店主" },
    { enum: "PLAYER_APOLLYON", name: "亚玻伦" },
    { enum: "PLAYER_THEFORGOTTEN", name: "遗骸" },
    { enum: "PLAYER_BETHANY", name: "伯大尼" },
    { enum: "PLAYER_JACOB", name: "雅各和以扫" }
  ];

  function createEngine() {
    var D = window.PROGRESS_DATA;
    var allTasks = D.catalog || [];
    var tasks = allTasks.filter(isObservableTask);
    var state = new State();
    var pool = new Pool(state, tasks);
    var recommend = new Recommend(tasks, D.routes || [], state, pool, allTasks);
    return {
      state: state,
      pool: pool,
      recommend: recommend,
      Config: Config,
      PLAYERS: PLAYERS,
      isChallengeGateTask: isChallengeGateTask,
      isObservableTask: isObservableTask
    };
  }

  /* ===== 道具图标（huijiwiki sprite 定位）===== */
  var ICON_SPRITES = {
    collectible: { url: "icons/Collectibles_sprite.png", width: 640, height: 1280, cols: 20, cell: 32 },
    trinket: { url: "icons/Trinket_sprite.png", width: 640, height: 320, cols: 20, cell: 32 },
    card: { url: "icons/Cards_sprite.png", width: 640, height: 160, cols: 20, cell: 32 },
    pill: { url: "icons/Pills_sprite.png", width: 32, height: 32, cols: 1, cell: 32 }
  };
  // collectible sprite 按 ID 顺序排列，但跳过这些隐藏道具 ID
  var COLLECTIBLE_HIDDEN = [43, 61, 235, 587, 613, 620, 630, 648, 662, 666, 718];

  function collectibleIndex(id) {
    var hidden = 0;
    for (var i = 0; i < COLLECTIBLE_HIDDEN.length; i++) {
      if (COLLECTIBLE_HIDDEN[i] < id) hidden++;
    }
    return id - hidden;
  }

  // 符文图标：32-39 用 Runes_sprite（background-size 288x32，每格 32px），40-41 用 Cards_sprite
  function runeIconStyle(id, size) {
    size = size || 24;
    var scale = size / 32;
    if (id >= 32 && id <= 39) {
      return {
        backgroundImage: "url(icons/Runes_sprite.png)",
        backgroundSize: (288 * scale) + "px " + (32 * scale) + "px",
        backgroundPosition: (-(id - 32) * 32 * scale) + "px 0px",
        width: size + "px",
        height: size + "px"
      };
    } else if (id >= 40 && id <= 41) {
      var s = ICON_SPRITES.card;
      var index = id - 1;
      var col = index % s.cols, row = Math.floor(index / s.cols);
      return {
        backgroundImage: "url(" + s.url + ")",
        backgroundSize: (s.width * scale) + "px " + (s.height * scale) + "px",
        backgroundPosition: (-col * 32 * scale) + "px " + (-row * 32 * scale) + "px",
        width: size + "px",
        height: size + "px"
      };
    }
    return null;
  }

  function iconStyle(kind, id, size) {
    size = size || 24;
    if (kind === "rune") return runeIconStyle(id, size);
    var s = ICON_SPRITES[kind];
    if (!s) return null;
    var index;
    if (kind === "collectible") index = collectibleIndex(id);
    else if (kind === "trinket" || kind === "card") index = id - 1;
    else if (kind === "pill") index = 0;
    else return null;
    if (index < 0 || index >= s.cols * (s.height / s.cell)) return null;
    var scale = size / s.cell;
    var col = index % s.cols, row = Math.floor(index / s.cols);
    return {
      backgroundImage: "url(" + s.url + ")",
      backgroundSize: (s.width * scale) + "px " + (s.height * scale) + "px",
      backgroundPosition: (-col * s.cell * scale) + "px " + (-row * s.cell * scale) + "px",
      width: size + "px",
      height: size + "px"
    };
  }

  // 成就图标（Achievement_sprite.jpg，64x64 网格，20 列，index = 成就ID - 1）
  var ACHIEVEMENT_SPRITE = { url: "icons/Achievement_sprite.jpg", width: 1280, height: 2112, cols: 20, cell: 64 };
  function achievementIconStyle(achievementId, size) {
    if (achievementId == null || achievementId < 1) return null;
    var index = achievementId - 1;
    var s = ACHIEVEMENT_SPRITE;
    if (index < 0 || index >= s.cols * (s.height / s.cell)) return null;
    size = size || 32;
    var scale = size / s.cell;
    var col = index % s.cols, row = Math.floor(index / s.cols);
    return {
      backgroundImage: "url(" + s.url + ")",
      backgroundSize: (s.width * scale) + "px " + (s.height * scale) + "px",
      backgroundPosition: (-col * s.cell * scale) + "px " + (-row * s.cell * scale) + "px",
      width: size + "px",
      height: size + "px"
    };
  }

  window.ProgressEngine = {
    Config: Config,
    State: State,
    Pool: Pool,
    Recommend: Recommend,
    PLAYERS: PLAYERS,
    createEngine: createEngine,
    iconStyle: iconStyle,
    achievementIconStyle: achievementIconStyle
  };
})();
