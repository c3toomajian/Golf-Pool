import { useState, useEffect, useCallback, useMemo } from "react";
import { kvGet, kvSet, espnScoreboard } from "./api.js";
import { PASSCODE as SETUP_PASSCODE } from "./constants.js";

const DEFAULT_PICK_COUNT = 15;

// First pick is always 100%, last is always 30%, evenly spaced between.
// For 15 picks this reproduces the original 100/95/90.../30 exactly.
function weightsFor(count) {
  const n = Math.max(1, count || DEFAULT_PICK_COUNT);
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => 1 - i * (0.7 / (n - 1)));
}

const money = (n) =>import { useState, useEffect, useCallback, useMemo } from "react";
import { kvGet, kvSet, espnScoreboard } from "./api.js";
import { PASSCODE as SETUP_PASSCODE } from "./constants.js";

const DEFAULT_PICK_COUNT = 15;

// First pick is always 100%, last is always 30%, evenly spaced between.
// For 15 picks this reproduces the original 100/95/90.../30 exactly.
function weightsFor(count) {
  const n = Math.max(1, count || DEFAULT_PICK_COUNT);
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => 1 - i * (0.7 / (n - 1)));
}

const money = (n) =>
  n == null || Number.isNaN(n)
    ? "--"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function parseScoreToNumber(display) {
  if (display == null) return null;
  const s = String(display).trim().toUpperCase();
  if (s === "E") return 0;
  if (s === "--" || s === "" || s === "CUT" || s === "WD" || s === "DQ") return null;
  const n = parseInt(s.replace("+", ""), 10);
  return Number.isNaN(n) ? null : n;
}

function normalizeName(s) {
  return (s || "")
    .replace(/\(a\)/gi, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z ]/g, "");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

function bestFuzzyMatch(input, candidates) {
  const norm = normalizeName(input);
  if (!norm || !candidates.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(norm, normalizeName(c));
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  const threshold = Math.max(2, Math.round(norm.length * 0.2));
  return bestDist > 0 && bestDist <= threshold ? best : null;
}

// Rounds that haven't started yet show up as bare placeholder entries
// (e.g. just {period: 3}, no hole detail at all) -- confirmed live against
// a player mid-round whose next-round entry was exactly this. Filter those
// out, then take the most recent round that's actually started.
function mostRecentStartedRound(c) {
  if (!c.linescores || !c.linescores.length) return null;
  const startedRounds = c.linescores.filter((r) => r.linescores && r.linescores.length > 0);
  return startedRounds.length ? startedRounds[startedRounds.length - 1] : null;
}

function thruFromCompetitor(c) {
  const round = mostRecentStartedRound(c);
  if (!round) return "-";
  const holes = round.linescores.length;
  if (holes >= 18) return "F";
  return String(holes);
}

function todayFromCompetitor(c) {
  const round = mostRecentStartedRound(c);
  if (!round || round.displayValue == null) return "-";
  return String(round.displayValue);
}

// Amateurs (ESPN marks them with a trailing "(a)") are excluded from rank
// entirely for payout purposes -- standard tour convention is that the pro
// below them moves up to fill that money position.
function computeRanks(rawPlayers) {
  const pros = rawPlayers.filter((p) => !p.isAmateur);
  const amateurs = rawPlayers.filter((p) => p.isAmateur);

  const sorted = [...pros].sort((a, b) => {
    if (a.scoreNum == null && b.scoreNum == null) return 0;
    if (a.scoreNum == null) return 1;
    if (b.scoreNum == null) return -1;
    return a.scoreNum - b.scoreNum;
  });

  const withRanks = [];
  let rank = 0;
  let prevScore;
  let seen = 0;
  for (const p of sorted) {
    seen += 1;
    if (p.scoreNum == null) {
      withRanks.push({ ...p, rank: null });
      continue;
    }
    if (p.scoreNum !== prevScore) {
      rank = seen;
      prevScore = p.scoreNum;
    }
    withRanks.push({ ...p, rank });
  }
  const tieCounts = {};
  withRanks.forEach((p) => {
    if (p.rank != null) tieCounts[p.rank] = (tieCounts[p.rank] || 0) + 1;
  });
  const rankedPros = withRanks.map((p) => ({ ...p, tieCount: p.rank != null ? tieCounts[p.rank] : 0 }));

  const rankedAmateurs = amateurs.map((p) => ({ ...p, rank: null, tieCount: 0 }));
  return [...rankedPros, ...rankedAmateurs];
}

function averagedPrize(rank, tieCount, payouts) {
  if (rank == null || !payouts || !payouts.length) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < tieCount; i++) {
    const idx = rank - 1 + i;
    sum += idx < payouts.length ? payouts[idx] : 0;
    n += 1;
  }
  return n ? sum / n : 0;
}

export default function App({ poolId, poolLabel, onLeavePool }) {
  const k = (key) => `pool:${poolId}:${key}`;

  const [tab, setTab] = useState("picks");
  const [friends, setFriends] = useState([]);
  const [newFriend, setNewFriend] = useState("");
  const [activeFriend, setActiveFriend] = useState("");
  const [picksDraft, setPicksDraft] = useState(Array(DEFAULT_PICK_COUNT).fill(""));
  const [allPicks, setAllPicks] = useState({});
  const [pickCount, setPickCount] = useState(DEFAULT_PICK_COUNT);
  const [picksLocked, setPicksLocked] = useState(false);
  const [tournamentName, setTournamentName] = useState("");
  const [eventId, setEventId] = useState("");
  const [payoutsText, setPayoutsText] = useState("");
  const [payouts, setPayouts] = useState([]);
  const [amateursText, setAmateursText] = useState("");
  const [amateurs, setAmateurs] = useState([]);
  const [liveField, setLiveField] = useState([]);
  const [liveError, setLiveError] = useState("");
  const [loadingLive, setLoadingLive] = useState(false);
  const [eventOptions, setEventOptions] = useState([]);
  const [setupUnlocked, setSetupUnlocked] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState("");
  const [passcodeError, setPasscodeError] = useState("");
  const [savedNotice, setSavedNotice] = useState("");
  const [resetArmed, setResetArmed] = useState(false);
  const [resetNotice, setResetNotice] = useState("");
  const [loaded, setLoaded] = useState(false);

  const loadAll = useCallback(async () => {
    let count = DEFAULT_PICK_COUNT;
    try {
      const infoRaw = await kvGet(k("tournament-info"));
      if (infoRaw) {
        const info = JSON.parse(infoRaw);
        setTournamentName(info.name || "");
        setEventId(info.eventId || "");
        setPayouts(info.payouts || []);
        setPayoutsText((info.payouts || []).join("\n"));
        setAmateurs(info.amateurs || []);
        setAmateursText((info.amateurs || []).join("\n"));
        count = info.pickCount || DEFAULT_PICK_COUNT;
        setPickCount(count);
        setPicksLocked(!!info.picksLocked);
      }

      const friendsRaw = await kvGet(k("friends"));
      const friendList = friendsRaw ? JSON.parse(friendsRaw) : [];
      setFriends(friendList);

      const picksMap = {};
      for (const f of friendList) {
        const raw = await kvGet(k(`picks:${normalizeName(f)}`));
        picksMap[f] = raw ? JSON.parse(raw) : Array(count).fill("");
      }
      setAllPicks(picksMap);
    } catch (e) {
      // fine on first run, nothing saved yet
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const resizeToCount = (arr, n) => Array.from({ length: n }, (_, i) => (arr && arr[i]) || "");

  useEffect(() => {
    if (activeFriend && allPicks[activeFriend]) {
      setPicksDraft(resizeToCount(allPicks[activeFriend], pickCount));
    } else {
      setPicksDraft(Array(pickCount).fill(""));
    }
  }, [activeFriend, allPicks, pickCount]);

  const applyCompetitors = (competitors, currentAmateurs) => {
    const amateurSet = new Set((currentAmateurs || []).map((n) => n.trim().toLowerCase()));
    const parsed = competitors
      .map((c) => {
        const name = ((c.athlete && (c.athlete.displayName || c.athlete.fullName)) || "").trim();
        return {
          name,
          isAmateur: amateurSet.has(name.toLowerCase()),
          scoreNum: parseScoreToNumber(c.score),
          scoreDisplay: c.score != null && c.score !== "" ? String(c.score) : "--",
          today: todayFromCompetitor(c),
          thru: thruFromCompetitor(c),
        };
      })
      .filter((p) => p.name);
    setLiveField(computeRanks(parsed));
  };

  const saveTournamentInfo = async (nextPayouts, nextEventId = eventId, nextName = tournamentName, nextPickCount = pickCount, nextAmateurs = amateurs, nextPicksLocked = picksLocked) => {
    try {
      await kvSet(k("tournament-info"), JSON.stringify({ name: nextName, eventId: nextEventId, payouts: nextPayouts, pickCount: nextPickCount, amateurs: nextAmateurs, picksLocked: nextPicksLocked }));
    } catch {}
  };

  const togglePicksLocked = () => {
    const next = !picksLocked;
    setPicksLocked(next);
    saveTournamentInfo(payouts, eventId, tournamentName, pickCount, amateurs, next);
  };

  const fetchLive = useCallback(async () => {
    setLoadingLive(true);
    setLiveError("");
    setEventOptions([]);
    try {
      // Always hit the general scoreboard endpoint -- the per-event "summary"
      // endpoint has proven unreliable (intermittent 502s), same issue found
      // and fixed in the Sheets version. This endpoint returns every live
      // PGA Tour event's full leaderboard in one response, so if an event ID
      // is set, we just filter to that one instead of calling a second,
      // flakier endpoint.
      const data = await espnScoreboard();
      const events = Array.isArray(data.events) ? data.events : [];

      let event;
      if (eventId.trim()) {
        event = events.filter((e) => String(e.id) === eventId.trim())[0];
        if (!event) {
          const available = events.map((e) => `${e.name} (id: ${e.id})`).join("; ");
          throw new Error(
            `Event id ${eventId.trim()} isn't in this week's scoreboard. Currently live: ${available || "nothing"}. Update the event ID on Setup to match.`
          );
        }
      } else if (events.length > 1) {
        setEventOptions(events.map((e) => ({ id: e.id, name: e.name })));
        setLiveError(
          `${events.length} PGA Tour events are live at once this week -- pick the right one on the Setup tab. Nothing was scored automatically since guessing wrong would silently attribute the wrong tournament's prize money.`
        );
        setLoadingLive(false);
        return;
      } else if (events.length === 1) {
        event = events[0];
      } else {
        throw new Error("ESPN isn't showing any live PGA Tour event right now.");
      }

      const competition = event.competitions && event.competitions[0];
      const competitors = competition && competition.competitors;
      if (!competitors) throw new Error(`Could not find a leaderboard for "${event.name}" in ESPN's response.`);
      applyCompetitors(competitors, amateurs);
      if (event.name && !tournamentName) {
        setTournamentName(event.name);
        saveTournamentInfo(payouts, eventId, event.name);
      }
    } catch (e) {
      setLiveError(`Couldn't load live results (${e.message}). Nothing was substituted, so scores reflect the last successful fetch only.`);
    }
    setLoadingLive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, tournamentName, payouts, amateurs]);

  useEffect(() => {
    if (loaded && liveField.length === 0) fetchLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Auto-refresh live results every 5 minutes, but only while someone's
  // actually looking at the Leaderboard tab -- no point polling ESPN in the
  // background for a tab nobody's viewing.
  useEffect(() => {
    if (tab !== "leaderboard") return;
    const interval = setInterval(() => {
      fetchLive();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const fieldNames = useMemo(
    () => Array.from(new Set(liveField.map((p) => (p.isAmateur ? `${p.name} (a)` : p.name)))).sort(),
    [liveField]
  );

  // For actually viewing the tournament -- everyone, amateurs included, at
  // their real position. Separate from the payout-only ranking above (which
  // deliberately excludes amateurs), so this never touches the prize math.
  const tournamentLeaderboard = useMemo(() => {
    if (!liveField.length) return [];
    const sorted = [...liveField].sort((a, b) => {
      if (a.scoreNum == null && b.scoreNum == null) return 0;
      if (a.scoreNum == null) return 1;
      if (b.scoreNum == null) return -1;
      return a.scoreNum - b.scoreNum;
    });
    const withRanks = [];
    let rank = 0, prevScore, seen = 0;
    for (const p of sorted) {
      seen += 1;
      let r;
      if (p.scoreNum == null) {
        r = null;
      } else {
        if (p.scoreNum !== prevScore) { rank = seen; prevScore = p.scoreNum; }
        r = rank;
      }
      withRanks.push({ ...p, displayRank: r });
    }
    const tieCounts = {};
    withRanks.forEach((p) => { if (p.displayRank != null) tieCounts[p.displayRank] = (tieCounts[p.displayRank] || 0) + 1; });
    return withRanks.map((p) => ({ ...p, tieCountDisplay: p.displayRank != null ? tieCounts[p.displayRank] : 0 }));
  }, [liveField]);

  const addFriend = async () => {
    if (picksLocked) return;
    const name = newFriend.trim();
    if (!name || friends.includes(name)) return;
    const updated = [...friends, name];
    setFriends(updated);
    setNewFriend("");
    setActiveFriend(name);
    try {
      await kvSet(k("friends"), JSON.stringify(updated));
    } catch {}
  };

  const [removeArmed, setRemoveArmed] = useState(null); // friend name currently awaiting confirm

  const removeFriend = async (name) => {
    if (removeArmed !== name) {
      setRemoveArmed(name);
      setTimeout(() => setRemoveArmed((cur) => (cur === name ? null : cur)), 4000);
      return;
    }
    setRemoveArmed(null);
    const updated = friends.filter((f) => f !== name);
    setFriends(updated);
    const nextPicks = { ...allPicks };
    delete nextPicks[name];
    setAllPicks(nextPicks);
    if (activeFriend === name) setActiveFriend("");
    try {
      await kvSet(k("friends"), JSON.stringify(updated));
      // Best-effort -- there's no delete endpoint on the Worker, so this just
      // overwrites their picks with blanks rather than truly removing the
      // key. Harmless: it's no longer in the friends list, so nothing reads
      // it, but worth knowing it's not a full cleanup.
      await kvSet(k(`picks:${normalizeName(name)}`), JSON.stringify(Array(pickCount).fill("")));
    } catch {}
  };

  const savePicks = async () => {
    if (!activeFriend || picksLocked) return;
    const cleaned = picksDraft.map((s) => s.trim());
    const updated = { ...allPicks, [activeFriend]: cleaned };
    setAllPicks(updated);
    try {
      await kvSet(k(`picks:${normalizeName(activeFriend)}`), JSON.stringify(cleaned));
      setSavedNotice("Picks saved.");
      setTimeout(() => setSavedNotice(""), 2000);
    } catch {
      setSavedNotice("Couldn't save. Try again.");
    }
  };

  const applyPayouts = () => {
    const lines = payoutsText.split("\n");
    const parsed = [];
    for (const line of lines) {
      const matches = line.replace(/,/g, "").match(/-?\d+(\.\d+)?/g);
      if (matches && matches.length) parsed.push(parseFloat(matches[matches.length - 1]));
    }
    setPayouts(parsed);
    saveTournamentInfo(parsed);
  };

  const applyAmateurs = () => {
    const parsed = amateursText
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n);
    setAmateurs(parsed);
    saveTournamentInfo(payouts, eventId, tournamentName, pickCount, parsed);
    // Re-tag the already-fetched field against the new list, rather than
    // making everyone wait on a fresh ESPN round-trip just to pick this up.
    if (liveField.length) {
      const amateurSet = new Set(parsed.map((n) => n.toLowerCase()));
      setLiveField((prev) =>
        computeRanks(
          prev.map((p) => ({ ...p, isAmateur: amateurSet.has(p.name.toLowerCase()) }))
        )
      );
    }
  };

  const chooseEvent = (id, name) => {
    setEventId(id);
    setTournamentName(name);
    saveTournamentInfo(payouts, id, name);
    setEventOptions([]);
    setTimeout(fetchLive, 0);
  };

  const resetAllPicks = async () => {
    if (!resetArmed) {
      setResetArmed(true);
      setResetNotice(`Click again to confirm -- this clears every friend's ${pickCount} picks.`);
      setTimeout(() => setResetArmed(false), 5000);
      return;
    }
    setResetArmed(false);
    const blank = Array(pickCount).fill("");
    try {
      for (const f of friends) {
        await kvSet(k(`picks:${normalizeName(f)}`), JSON.stringify(blank));
      }
      const cleared = {};
      friends.forEach((f) => { cleared[f] = blank; });
      setAllPicks(cleared);
      if (activeFriend) setPicksDraft(blank);
      setResetNotice("All picks cleared for the new week.");
      setTimeout(() => setResetNotice(""), 3000);
    } catch {
      setResetNotice("Couldn't clear picks. Try again.");
    }
  };

  const results = useMemo(() => {
    if (!liveField.length || !payouts.length) return [];
    const byName = new Map(liveField.map((p) => [normalizeName(p.name), p]));
    const weights = weightsFor(pickCount);
    return Object.entries(allPicks)
      .map(([friend, picks]) => {
        let total = 0;
        const rows = picks.map((golfer, i) => {
          const weight = i < weights.length ? weights[i] : 0;
          const match = golfer ? byName.get(normalizeName(golfer)) : null;
          const isAmateurPick = !!(match && match.isAmateur);
          const prize = match && !isAmateurPick ? averagedPrize(match.rank, match.tieCount, payouts) : 0;
          const adjusted = prize * weight;
          total += adjusted;
          return {
            golfer,
            score: match ? match.scoreDisplay : null,
            today: match ? match.today : null,
            rank: match ? match.rank : null,
            tieCount: match ? match.tieCount : 0,
            isAmateurPick,
            prize,
            adjusted,
            weight,
          };
        });
        return { friend, total, rows };
      })
      .sort((a, b) => b.total - a.total);
  }, [allPicks, liveField, payouts, pickCount]);

  const tabBtn = (id, label) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: "10px 18px",
        border: "none",
        background: "transparent",
        fontFamily: "'Fraunces', serif",
        fontSize: 15,
        fontWeight: tab === id ? 600 : 400,
        color: tab === id ? "#1B3A2F" : "#8A8368",
        borderBottom: tab === id ? "2px solid #B8912F" : "2px solid transparent",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: "#F6F1E4", color: "#24221C", minHeight: "100vh", padding: "0 0 3rem" }}>
      <div style={{ background: "#1B3A2F", padding: "2rem 2rem 1.25rem", borderBottom: "4px solid #B8912F" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ color: "#C9BFA0", fontSize: 12, letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>
              {poolLabel || "The pool"}
            </div>
            <h1 style={{ fontFamily: "'Fraunces', serif", color: "#F6F1E4", fontSize: 32, fontWeight: 700, margin: 0 }}>
              {tournamentName || "This week's tournament"}
            </h1>
          </div>
          <button
            onClick={onLeavePool}
            style={{ border: "none", background: "none", color: "#C9BFA0", fontSize: 13, cursor: "pointer", textDecoration: "underline", padding: 0 }}
          >
            All pools
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "0 2rem" }}>
        <div style={{ display: "flex", gap: 8, borderBottom: "1px solid #C9BFA0", marginTop: "1rem" }}>
          {tabBtn("picks", "My picks")}
          {tabBtn("leaderboard", "Leaderboard")}
          {tabBtn("setup", "Setup")}
        </div>

        {!loaded && <p style={{ color: "#8A8368", marginTop: "2rem" }}>Loading...</p>}

        {loaded && tab === "picks" && (
          <div style={{ marginTop: "2rem" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: "1.5rem" }}>
              <label style={{ fontSize: 14, color: "#5B5641" }}>You are:</label>
              <select
                value={activeFriend}
                onChange={(e) => setActiveFriend(e.target.value)}
                style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #C9BFA0", background: "#fff", fontSize: 14 }}
              >
                <option value="">Select your name</option>
                {friends.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <input
                placeholder="Add new name"
                value={newFriend}
                onChange={(e) => setNewFriend(e.target.value)}
                disabled={picksLocked}
                style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #C9BFA0", fontSize: 14, opacity: picksLocked ? 0.5 : 1 }}
              />
              <button
                onClick={addFriend}
                disabled={picksLocked}
                style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #1B3A2F", background: picksLocked ? "#8A8368" : "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: picksLocked ? "default" : "pointer" }}
              >
                Add
              </button>
            </div>

            {picksLocked && (
              <div style={{ background: "#FAECE7", border: "1px solid #F0997B", color: "#712B13", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: "1.5rem" }}>
                Picks are locked for this pool right now -- nobody can add themselves or change picks until it's unlocked on Setup.
              </div>
            )}

            {activeFriend ? (
              <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
                <p style={{ fontSize: 13, color: "#8A8368", marginTop: 0 }}>
                  Rank your {pickCount} golfers, 1 (most confident) to {pickCount}. Start typing to pick from this week's field.
                </p>
                {fieldNames.length === 0 && loadingLive && (
                  <p style={{ fontSize: 12, color: "#5B5641", marginTop: -6 }}>Loading this week's field from ESPN...</p>
                )}
                {fieldNames.length === 0 && !loadingLive && liveError && (
                  <p style={{ fontSize: 12, color: "#993C1D", marginTop: -6 }}>
                    Field list failed to load: {liveError}{" "}
                    <button type="button" onClick={fetchLive} style={{ border: "none", background: "none", color: "#993C1D", textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 12 }}>Retry</button>
                  </p>
                )}
                <datalist id="field-names">
                  {fieldNames.map((n) => <option key={n} value={n} />)}
                </datalist>
                {picksDraft.map((val, i) => {
                  const trimmed = val.trim();
                  const exact = trimmed && fieldNames.some((n) => normalizeName(n) === normalizeName(trimmed));
                  const suggestion = trimmed && !exact && fieldNames.length ? bestFuzzyMatch(trimmed, fieldNames) : null;
                  const noMatch = trimmed && !exact && fieldNames.length && !suggestion;
                  return (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, width: 28, color: "#B8912F", fontWeight: 600 }}>{i + 1}</span>
                        <input
                          value={val}
                          list="field-names"
                          disabled={picksLocked}
                          onChange={(e) => {
                            const next = [...picksDraft];
                            next[i] = e.target.value;
                            setPicksDraft(next);
                          }}
                          style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${noMatch || suggestion ? "#EF9F27" : "#E1DAC4"}`, fontSize: 14, opacity: picksLocked ? 0.6 : 1 }}
                        />
                      </div>
                      {suggestion && (
                        <div style={{ marginLeft: 38, marginTop: 4, fontSize: 12, color: "#854F0B" }}>
                          Not in this week's field. Did you mean{" "}
                          <button type="button" onClick={() => { const next = [...picksDraft]; next[i] = suggestion; setPicksDraft(next); }} style={{ border: "none", background: "none", color: "#854F0B", fontWeight: 600, textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 12 }}>{suggestion}</button>?
                        </div>
                      )}
                      {noMatch && <div style={{ marginLeft: 38, marginTop: 4, fontSize: 12, color: "#993C1D" }}>Not found in this week's field -- double check the spelling.</div>}
                    </div>
                  );
                })}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: "1rem" }}>
                  <button
                    onClick={savePicks}
                    disabled={picksLocked}
                    style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: picksLocked ? "#8A8368" : "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: picksLocked ? "default" : "pointer" }}
                  >
                    Save picks
                  </button>
                  {savedNotice && <span style={{ fontSize: 13, color: "#5B5641" }}>{savedNotice}</span>}
                </div>
              </div>
            ) : (
              <p style={{ color: "#8A8368" }}>Pick your name above (or add it) to enter your 15.</p>
            )}
          </div>
        )}

        {loaded && tab === "leaderboard" && (
          <div style={{ marginTop: "2rem" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: "1.5rem" }}>
              <button
                onClick={fetchLive}
                disabled={loadingLive}
                style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: loadingLive ? "#8A8368" : "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: loadingLive ? "default" : "pointer" }}
              >
                {loadingLive ? "Fetching..." : "Refresh live results"}
              </button>
              {liveField.length > 0 && <span style={{ fontSize: 13, color: "#5B5641" }}>{liveField.length} golfers loaded</span>}
            </div>

            {liveError && (
              <div style={{ background: "#FAECE7", border: "1px solid #F0997B", color: "#712B13", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: "1.5rem" }}>{liveError}</div>
            )}
            {!payouts.length && (
              <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", color: "#633806", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: "1.5rem" }}>
                No payout table set yet. Add this week's prize money by position on the Setup tab first.
              </div>
            )}
            {results.length > 0 && results.some((r) => r.rows.some((row) => row.golfer && !row.rank && !row.isAmateurPick)) && (
              <div style={{ background: "#FCEBEB", border: "1px solid #F09595", color: "#791F1F", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: "1.5rem" }}>
                Some picks don't match anyone in the live field, so they're currently scoring as $0. Open a name below to see which.
              </div>
            )}

            {results.length > 0 && (
              <div style={{ background: "#14140F", borderRadius: 10, padding: "1.5rem", marginBottom: "2rem" }}>
                {results.map((r, i) => (
                  <div key={r.friend} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px", borderBottom: i < results.length - 1 ? "1px solid #2B2A22" : "none" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#E7C368", fontSize: 15, width: 24 }}>{i + 1}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#F6F1E4", fontSize: 16, letterSpacing: 1 }}>{r.friend.toUpperCase()}</span>
                    </div>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#E7C368", fontSize: 17, fontWeight: 600 }}>{money(r.total)}</span>
                  </div>
                ))}
              </div>
            )}

            <details style={{ marginBottom: "1.5rem", background: "#fff", border: "1px solid #C9BFA0", borderRadius: 8, padding: "8px 14px" }}>
              <summary style={{ cursor: "pointer", fontFamily: "'Fraunces', serif", fontSize: 15, padding: "6px 0" }}>Leaderboard</summary>
              {tournamentLeaderboard.length === 0 ? (
                <p style={{ fontSize: 13, color: "#8A8368" }}>No live field loaded yet.</p>
              ) : (
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table style={{ width: "100%", minWidth: 480, fontSize: 13, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "#8A8368", textAlign: "left" }}>
                        <th style={{ padding: "4px 6px" }}>Position</th>
                        <th style={{ padding: "4px 6px" }}>Player</th>
                        <th style={{ padding: "4px 6px" }}>Score</th>
                        <th style={{ padding: "4px 6px" }}>Today</th>
                        <th style={{ padding: "4px 6px" }}>Thru</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tournamentLeaderboard.map((p, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #EFEADA" }}>
                          <td style={{ padding: "4px 6px" }}>
                            {p.displayRank ? `${p.tieCountDisplay > 1 ? "T" : ""}${p.displayRank}` : "--"}
                          </td>
                          <td style={{ padding: "4px 6px" }}>
                            {p.name}
                            {p.isAmateur && <span style={{ color: "#854F0B", marginLeft: 6, fontSize: 11 }}>(a)</span>}
                          </td>
                          <td style={{ padding: "4px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{p.scoreDisplay || "--"}</td>
                          <td style={{ padding: "4px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{p.today || "--"}</td>
                          <td style={{ padding: "4px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{p.thru || "--"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>

            {results.map((r) => (
              <details key={r.friend} style={{ marginBottom: 10, background: "#fff", border: "1px solid #C9BFA0", borderRadius: 8, padding: "8px 14px" }}>
                <summary style={{ cursor: "pointer", fontFamily: "'Fraunces', serif", fontSize: 15, padding: "6px 0" }}>{r.friend} -- {money(r.total)}</summary>
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table style={{ width: "100%", minWidth: 480, fontSize: 13, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: "#8A8368", textAlign: "left" }}>
                      <th style={{ padding: "4px 6px" }}>Pick</th>
                      <th style={{ padding: "4px 6px" }}>Golfer</th>
                      <th style={{ padding: "4px 6px" }}>Score</th>
                      <th style={{ padding: "4px 6px" }}>Today</th>
                      <th style={{ padding: "4px 6px" }}>Position</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>Prize</th>
                      <th style={{ padding: "4px 6px" }}>Weight</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>Adjusted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((row, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #EFEADA" }}>
                        <td style={{ padding: "4px 6px" }}>{i + 1}</td>
                        <td style={{ padding: "4px 6px", color: row.golfer && !row.rank && !row.isAmateurPick ? "#993C1D" : "inherit" }}>
                          {row.golfer || "--"}
                          {row.golfer && !row.rank && !row.isAmateurPick && <span style={{ display: "block", fontSize: 11 }}>no match in live field</span>}
                          {row.isAmateurPick && <span style={{ display: "block", fontSize: 11, color: "#854F0B" }}>amateur -- no prize money</span>}
                        </td>
                        <td style={{ padding: "4px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{row.score || "--"}</td>
                        <td style={{ padding: "4px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{row.today || "--"}</td>
                        <td style={{ padding: "4px 6px" }}>{row.rank ? `${row.tieCount > 1 ? "T" : ""}${row.rank}` : "--"}</td>
                        <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{money(row.prize)}</td>
                        <td style={{ padding: "4px 6px" }}>{Math.round(row.weight * 100)}%</td>
                        <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{money(row.adjusted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </details>
            ))}
          </div>
        )}

        {loaded && tab === "setup" && !setupUnlocked && (
          <div style={{ marginTop: "2rem", maxWidth: 340 }}>
            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Setup is locked</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>Enter the passcode to change tournament and payout settings.</p>
              <input
                type="password"
                value={passcodeInput}
                onChange={(e) => { setPasscodeInput(e.target.value); setPasscodeError(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (passcodeInput === SETUP_PASSCODE) setSetupUnlocked(true);
                    else setPasscodeError("That's not it.");
                  }
                }}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", marginBottom: 10 }}
              />
              <button
                onClick={() => { if (passcodeInput === SETUP_PASSCODE) setSetupUnlocked(true); else setPasscodeError("That's not it."); }}
                style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}
              >
                Unlock
              </button>
              {passcodeError && <p style={{ fontSize: 13, color: "#993C1D", marginTop: 10 }}>{passcodeError}</p>}
            </div>
          </div>
        )}

        {loaded && tab === "setup" && setupUnlocked && (
          <div style={{ marginTop: "2rem", display: "grid", gap: "1.5rem" }}>
            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Tournament</h3>
              <label style={{ fontSize: 13, color: "#5B5641", display: "block", marginBottom: 4 }}>Name (optional, auto-fills from ESPN)</label>
              <input
                value={tournamentName}
                onChange={(e) => setTournamentName(e.target.value)}
                onBlur={() => saveTournamentInfo(payouts)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", marginBottom: 12 }}
              />
              <label style={{ fontSize: 13, color: "#5B5641", display: "block", marginBottom: 4 }}>ESPN event ID (leave blank only on weeks with a single PGA Tour event)</label>
              <input
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                onBlur={() => saveTournamentInfo(payouts)}
                placeholder="e.g. 401811957"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", marginBottom: 12 }}
              />
              <label style={{ fontSize: 13, color: "#5B5641", display: "block", marginBottom: 4 }}>
                How many picks per person? (weights spread evenly from 100% to 30% across however many you set)
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={pickCount}
                onChange={(e) => setPickCount(Math.max(1, parseInt(e.target.value, 10) || DEFAULT_PICK_COUNT))}
                onBlur={() => saveTournamentInfo(payouts, eventId, tournamentName, pickCount)}
                style={{ width: 100, padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4" }}
              />
              <p style={{ fontSize: 12, color: "#8A8368", marginTop: 6, marginBottom: 0 }}>
                Changing this after people have already saved picks doesn't resize their existing picks -- any of their
                picks past the new count just stop counting toward their total, rather than being deleted.
              </p>
              {eventOptions.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ fontSize: 13, color: "#993C1D", marginBottom: 6 }}>Multiple PGA Tour events are live right now -- choose the one your pool is tracking:</p>
                  {eventOptions.map((ev) => (
                    <button key={ev.id} onClick={() => chooseEvent(ev.id, ev.name)} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", marginBottom: 6, borderRadius: 6, border: "1px solid #C9BFA0", background: "#F6F1E4", cursor: "pointer", fontSize: 14 }}>
                      {ev.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({ev.id})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Lock picks</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>
                When locked, nobody can add themselves or change any picks -- useful once the tournament actually starts,
                so no one can sneak a change after seeing early results. Setup stays reachable to you either way.
              </p>
              <button
                onClick={togglePicksLocked}
                style={{
                  padding: "10px 18px",
                  borderRadius: 6,
                  border: `1px solid ${picksLocked ? "#993C1D" : "#1B3A2F"}`,
                  background: picksLocked ? "#993C1D" : "#1B3A2F",
                  color: "#F6F1E4",
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                {picksLocked ? "Picks are locked -- click to unlock" : "Picks are open -- click to lock"}
              </button>
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Prize money by finish</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>Paste one amount per line, in finish order. Extra text on a line is fine -- only the last number is used.</p>
              <textarea
                value={payoutsText}
                onChange={(e) => setPayoutsText(e.target.value)}
                rows={10}
                placeholder={"4500000\n2430000\n1532530\n..."}
                style={{ width: "100%", padding: 10, borderRadius: 6, border: "1px solid #E1DAC4", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}
              />
              <button onClick={applyPayouts} style={{ marginTop: 10, padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}>Save payout table</button>
              {payouts.length > 0 && <span style={{ marginLeft: 12, fontSize: 13, color: "#5B5641" }}>{payouts.length} positions saved</span>}
              {payouts.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, color: "#5B5641" }}>
                    Show numbered list (verify positions lined up correctly)
                  </summary>
                  <div style={{ marginTop: 8, maxHeight: 240, overflowY: "auto", border: "1px solid #EFEADA", borderRadius: 6 }}>
                    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace" }}>
                      <tbody>
                        {payouts.map((amount, i) => (
                          <tr key={i} style={{ borderTop: i > 0 ? "1px solid #F1EEE0" : "none" }}>
                            <td style={{ padding: "4px 10px", color: "#8A8368", width: 50 }}>{i + 1}</td>
                            <td style={{ padding: "4px 10px", textAlign: "right" }}>{money(amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Amateurs this week</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>
                ESPN's data doesn't flag amateur status anywhere -- confirmed by directly inspecting a real amateur's full
                record during testing, nothing marks it. So this has to be entered manually: one full name per line,
                matching ESPN's spelling exactly (check the Leaderboard tab after a refresh if you're not sure how they're
                spelled). Leave blank on weeks with no amateurs in the field -- most weeks, this card does nothing.
              </p>
              <textarea
                value={amateursText}
                onChange={(e) => setAmateursText(e.target.value)}
                rows={4}
                placeholder={"Nevill Ruiter\nMason Howell\n..."}
                style={{ width: "100%", padding: 10, borderRadius: 6, border: "1px solid #E1DAC4", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}
              />
              <button onClick={applyAmateurs} style={{ marginTop: 10, padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}>Save amateur list</button>
              {amateurs.length > 0 && <span style={{ marginLeft: 12, fontSize: 13, color: "#5B5641" }}>{amateurs.length} marked</span>}
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Manage friends</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>
                Remove someone who was added by mistake, a duplicate, or dropped out. This deletes their picks too --
                not just their name.
              </p>
              {friends.length === 0 && <p style={{ fontSize: 13, color: "#8A8368" }}>No one's added yet.</p>}
              {friends.length > 0 && (
                <div style={{ display: "grid", gap: 6 }}>
                  {friends.map((f) => (
                    <div key={f} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderRadius: 6, border: "1px solid #EFEADA" }}>
                      <span style={{ fontSize: 14 }}>{f}</span>
                      <button
                        onClick={() => removeFriend(f)}
                        style={{
                          padding: "4px 12px",
                          borderRadius: 6,
                          border: `1px solid ${removeArmed === f ? "#A32D2D" : "#C9BFA0"}`,
                          background: removeArmed === f ? "#A32D2D" : "#fff",
                          color: removeArmed === f ? "#fff" : "#993C1D",
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        {removeArmed === f ? "Confirm?" : "Remove"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>New week</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>Clears everyone's 15 picks. Tournament name, event ID, and payout table are left alone.</p>
              <button
                onClick={resetAllPicks}
                style={{ padding: "10px 18px", borderRadius: 6, border: `1px solid ${resetArmed ? "#A32D2D" : "#993C1D"}`, background: resetArmed ? "#A32D2D" : "#fff", color: resetArmed ? "#fff" : "#993C1D", fontSize: 14, cursor: "pointer" }}
              >
                {resetArmed ? "Click again to confirm" : "Clear all picks for a new week"}
              </button>
              {resetNotice && <p style={{ fontSize: 13, color: "#5B5641", marginTop: 10 }}>{resetNotice}</p>}
            </div>

            <div style={{ background: "#F1EFE8", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.25rem", fontSize: 13, color: "#5B5641" }}>
              Live results come from an unofficial ESPN endpoint, relayed through this site's own Worker. It isn't a documented,
              guaranteed API -- for real money settlement, cross-check final numbers against ESPN's official leaderboard before paying out.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

  n == null || Number.isNaN(n)
    ? "--"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function parseScoreToNumber(display) {
  if (display == null) return null;
  const s = String(display).trim().toUpperCase();
  if (s === "E") return 0;
  if (s === "--" || s === "" || s === "CUT" || s === "WD" || s === "DQ") return null;
  const n = parseInt(s.replace("+", ""), 10);
  return Number.isNaN(n) ? null : n;
}

function normalizeName(s) {
  return (s || "")
    .replace(/\(a\)/gi, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z ]/g, "");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

function bestFuzzyMatch(input, candidates) {
  const norm = normalizeName(input);
  if (!norm || !candidates.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(norm, normalizeName(c));
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  const threshold = Math.max(2, Math.round(norm.length * 0.2));
  return bestDist > 0 && bestDist <= threshold ? best : null;
}

function thruFromCompetitor(c) {
  if (!c.linescores || !c.linescores.length) return "-";
  // Rounds that haven't started yet show up as bare placeholder entries
  // (e.g. just {period: 3}, no hole detail at all) -- confirmed live against
  // a player mid-round-2 whose round-3 entry was exactly this. Filter those
  // out, then take the most recent round that's actually started.
  const startedRounds = c.linescores.filter((r) => r.linescores && r.linescores.length > 0);
  if (!startedRounds.length) return "-";
  const current = startedRounds[startedRounds.length - 1];
  const holes = current.linescores.length;
  if (holes >= 18) return "F";
  return String(holes);
}

// Amateurs (ESPN marks them with a trailing "(a)") are excluded from rank
// entirely for payout purposes -- standard tour convention is that the pro
// below them moves up to fill that money position.
function computeRanks(rawPlayers) {
  const pros = rawPlayers.filter((p) => !p.isAmateur);
  const amateurs = rawPlayers.filter((p) => p.isAmateur);

  const sorted = [...pros].sort((a, b) => {
    if (a.scoreNum == null && b.scoreNum == null) return 0;
    if (a.scoreNum == null) return 1;
    if (b.scoreNum == null) return -1;
    return a.scoreNum - b.scoreNum;
  });

  const withRanks = [];
  let rank = 0;
  let prevScore;
  let seen = 0;
  for (const p of sorted) {
    seen += 1;
    if (p.scoreNum == null) {
      withRanks.push({ ...p, rank: null });
      continue;
    }
    if (p.scoreNum !== prevScore) {
      rank = seen;
      prevScore = p.scoreNum;
    }
    withRanks.push({ ...p, rank });
  }
  const tieCounts = {};
  withRanks.forEach((p) => {
    if (p.rank != null) tieCounts[p.rank] = (tieCounts[p.rank] || 0) + 1;
  });
  const rankedPros = withRanks.map((p) => ({ ...p, tieCount: p.rank != null ? tieCounts[p.rank] : 0 }));

  const rankedAmateurs = amateurs.map((p) => ({ ...p, rank: null, tieCount: 0 }));
  return [...rankedPros, ...rankedAmateurs];
}

function averagedPrize(rank, tieCount, payouts) {
  if (rank == null || !payouts || !payouts.length) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < tieCount; i++) {
    const idx = rank - 1 + i;
    sum += idx < payouts.length ? payouts[idx] : 0;
    n += 1;
  }
  return n ? sum / n : 0;
}

export default function App({ poolId, poolLabel, onLeavePool }) {
  const k = (key) => `pool:${poolId}:${key}`;

  const [tab, setTab] = useState("picks");
  const [friends, setFriends] = useState([]);
  const [newFriend, setNewFriend] = useState("");
  const [activeFriend, setActiveFriend] = useState("");
  const [picksDraft, setPicksDraft] = useState(Array(DEFAULT_PICK_COUNT).fill(""));
  const [allPicks, setAllPicks] = useState({});
  const [pickCount, setPickCount] = useState(DEFAULT_PICK_COUNT);
  const [picksLocked, setPicksLocked] = useState(false);
  const [tournamentName, setTournamentName] = useState("");
  const [eventId, setEventId] = useState("");
  const [payoutsText, setPayoutsText] = useState("");
  const [payouts, setPayouts] = useState([]);
  const [amateursText, setAmateursText] = useState("");
  const [amateurs, setAmateurs] = useState([]);
  const [liveField, setLiveField] = useState([]);
  const [liveError, setLiveError] = useState("");
  const [loadingLive, setLoadingLive] = useState(false);
  const [eventOptions, setEventOptions] = useState([]);
  const [setupUnlocked, setSetupUnlocked] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState("");
  const [passcodeError, setPasscodeError] = useState("");
  const [savedNotice, setSavedNotice] = useState("");
  const [resetArmed, setResetArmed] = useState(false);
  const [resetNotice, setResetNotice] = useState("");
  const [loaded, setLoaded] = useState(false);

  const loadAll = useCallback(async () => {
    let count = DEFAULT_PICK_COUNT;
    try {
      const infoRaw = await kvGet(k("tournament-info"));
      if (infoRaw) {
        const info = JSON.parse(infoRaw);
        setTournamentName(info.name || "");
        setEventId(info.eventId || "");
        setPayouts(info.payouts || []);
        setPayoutsText((info.payouts || []).join("\n"));
        setAmateurs(info.amateurs || []);
        setAmateursText((info.amateurs || []).join("\n"));
        count = info.pickCount || DEFAULT_PICK_COUNT;
        setPickCount(count);
        setPicksLocked(!!info.picksLocked);
      }

      const friendsRaw = await kvGet(k("friends"));
      const friendList = friendsRaw ? JSON.parse(friendsRaw) : [];
      setFriends(friendList);

      const picksMap = {};
      for (const f of friendList) {
        const raw = await kvGet(k(`picks:${normalizeName(f)}`));
        picksMap[f] = raw ? JSON.parse(raw) : Array(count).fill("");
      }
      setAllPicks(picksMap);
    } catch (e) {
      // fine on first run, nothing saved yet
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const resizeToCount = (arr, n) => Array.from({ length: n }, (_, i) => (arr && arr[i]) || "");

  useEffect(() => {
    if (activeFriend && allPicks[activeFriend]) {
      setPicksDraft(resizeToCount(allPicks[activeFriend], pickCount));
    } else {
      setPicksDraft(Array(pickCount).fill(""));
    }
  }, [activeFriend, allPicks, pickCount]);

  const applyCompetitors = (competitors, currentAmateurs) => {
    const amateurSet = new Set((currentAmateurs || []).map((n) => n.trim().toLowerCase()));
    const parsed = competitors
      .map((c) => {
        const name = ((c.athlete && (c.athlete.displayName || c.athlete.fullName)) || "").trim();
        return {
          name,
          isAmateur: amateurSet.has(name.toLowerCase()),
          scoreNum: parseScoreToNumber(c.score),
          scoreDisplay: c.score != null && c.score !== "" ? String(c.score) : "--",
          thru: thruFromCompetitor(c),
        };
      })
      .filter((p) => p.name);
    setLiveField(computeRanks(parsed));
  };

  const saveTournamentInfo = async (nextPayouts, nextEventId = eventId, nextName = tournamentName, nextPickCount = pickCount, nextAmateurs = amateurs, nextPicksLocked = picksLocked) => {
    try {
      await kvSet(k("tournament-info"), JSON.stringify({ name: nextName, eventId: nextEventId, payouts: nextPayouts, pickCount: nextPickCount, amateurs: nextAmateurs, picksLocked: nextPicksLocked }));
    } catch {}
  };

  const togglePicksLocked = () => {
    const next = !picksLocked;
    setPicksLocked(next);
    saveTournamentInfo(payouts, eventId, tournamentName, pickCount, amateurs, next);
  };

  const fetchLive = useCallback(async () => {
    setLoadingLive(true);
    setLiveError("");
    setEventOptions([]);
    try {
      // Always hit the general scoreboard endpoint -- the per-event "summary"
      // endpoint has proven unreliable (intermittent 502s), same issue found
      // and fixed in the Sheets version. This endpoint returns every live
      // PGA Tour event's full leaderboard in one response, so if an event ID
      // is set, we just filter to that one instead of calling a second,
      // flakier endpoint.
      const data = await espnScoreboard();
      const events = Array.isArray(data.events) ? data.events : [];

      let event;
      if (eventId.trim()) {
        event = events.filter((e) => String(e.id) === eventId.trim())[0];
        if (!event) {
          const available = events.map((e) => `${e.name} (id: ${e.id})`).join("; ");
          throw new Error(
            `Event id ${eventId.trim()} isn't in this week's scoreboard. Currently live: ${available || "nothing"}. Update the event ID on Setup to match.`
          );
        }
      } else if (events.length > 1) {
        setEventOptions(events.map((e) => ({ id: e.id, name: e.name })));
        setLiveError(
          `${events.length} PGA Tour events are live at once this week -- pick the right one on the Setup tab. Nothing was scored automatically since guessing wrong would silently attribute the wrong tournament's prize money.`
        );
        setLoadingLive(false);
        return;
      } else if (events.length === 1) {
        event = events[0];
      } else {
        throw new Error("ESPN isn't showing any live PGA Tour event right now.");
      }

      const competition = event.competitions && event.competitions[0];
      const competitors = competition && competition.competitors;
      if (!competitors) throw new Error(`Could not find a leaderboard for "${event.name}" in ESPN's response.`);
      applyCompetitors(competitors, amateurs);
      if (event.name && !tournamentName) {
        setTournamentName(event.name);
        saveTournamentInfo(payouts, eventId, event.name);
      }
    } catch (e) {
      setLiveError(`Couldn't load live results (${e.message}). Nothing was substituted, so scores reflect the last successful fetch only.`);
    }
    setLoadingLive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, tournamentName, payouts, amateurs]);

  useEffect(() => {
    if (loaded && liveField.length === 0) fetchLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Auto-refresh live results every 5 minutes, but only while someone's
  // actually looking at the Leaderboard tab -- no point polling ESPN in the
  // background for a tab nobody's viewing.
  useEffect(() => {
    if (tab !== "leaderboard") return;
    const interval = setInterval(() => {
      fetchLive();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const fieldNames = useMemo(
    () => Array.from(new Set(liveField.map((p) => (p.isAmateur ? `${p.name} (a)` : p.name)))).sort(),
    [liveField]
  );

  // For actually viewing the tournament -- everyone, amateurs included, at
  // their real position. Separate from the payout-only ranking above (which
  // deliberately excludes amateurs), so this never touches the prize math.
  const tournamentLeaderboard = useMemo(() => {
    if (!liveField.length) return [];
    const sorted = [...liveField].sort((a, b) => {
      if (a.scoreNum == null && b.scoreNum == null) return 0;
      if (a.scoreNum == null) return 1;
      if (b.scoreNum == null) return -1;
      return a.scoreNum - b.scoreNum;
    });
    const withRanks = [];
    let rank = 0, prevScore, seen = 0;
    for (const p of sorted) {
      seen += 1;
      let r;
      if (p.scoreNum == null) {
        r = null;
      } else {
        if (p.scoreNum !== prevScore) { rank = seen; prevScore = p.scoreNum; }
        r = rank;
      }
      withRanks.push({ ...p, displayRank: r });
    }
    const tieCounts = {};
    withRanks.forEach((p) => { if (p.displayRank != null) tieCounts[p.displayRank] = (tieCounts[p.displayRank] || 0) + 1; });
    return withRanks.map((p) => ({ ...p, tieCountDisplay: p.displayRank != null ? tieCounts[p.displayRank] : 0 }));
  }, [liveField]);

  const addFriend = async () => {
    if (picksLocked) return;
    const name = newFriend.trim();
    if (!name || friends.includes(name)) return;
    const updated = [...friends, name];
    setFriends(updated);
    setNewFriend("");
    setActiveFriend(name);
    try {
      await kvSet(k("friends"), JSON.stringify(updated));
    } catch {}
  };

  const [removeArmed, setRemoveArmed] = useState(null); // friend name currently awaiting confirm

  const removeFriend = async (name) => {
    if (removeArmed !== name) {
      setRemoveArmed(name);
      setTimeout(() => setRemoveArmed((cur) => (cur === name ? null : cur)), 4000);
      return;
    }
    setRemoveArmed(null);
    const updated = friends.filter((f) => f !== name);
    setFriends(updated);
    const nextPicks = { ...allPicks };
    delete nextPicks[name];
    setAllPicks(nextPicks);
    if (activeFriend === name) setActiveFriend("");
    try {
      await kvSet(k("friends"), JSON.stringify(updated));
      // Best-effort -- there's no delete endpoint on the Worker, so this just
      // overwrites their picks with blanks rather than truly removing the
      // key. Harmless: it's no longer in the friends list, so nothing reads
      // it, but worth knowing it's not a full cleanup.
      await kvSet(k(`picks:${normalizeName(name)}`), JSON.stringify(Array(pickCount).fill("")));
    } catch {}
  };

  const savePicks = async () => {
    if (!activeFriend || picksLocked) return;
    const cleaned = picksDraft.map((s) => s.trim());
    const updated = { ...allPicks, [activeFriend]: cleaned };
    setAllPicks(updated);
    try {
      await kvSet(k(`picks:${normalizeName(activeFriend)}`), JSON.stringify(cleaned));
      setSavedNotice("Picks saved.");
      setTimeout(() => setSavedNotice(""), 2000);
    } catch {
      setSavedNotice("Couldn't save. Try again.");
    }
  };

  const applyPayouts = () => {
    const lines = payoutsText.split("\n");
    const parsed = [];
    for (const line of lines) {
      const matches = line.replace(/,/g, "").match(/-?\d+(\.\d+)?/g);
      if (matches && matches.length) parsed.push(parseFloat(matches[matches.length - 1]));
    }
    setPayouts(parsed);
    saveTournamentInfo(parsed);
  };

  const applyAmateurs = () => {
    const parsed = amateursText
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n);
    setAmateurs(parsed);
    saveTournamentInfo(payouts, eventId, tournamentName, pickCount, parsed);
    // Re-tag the already-fetched field against the new list, rather than
    // making everyone wait on a fresh ESPN round-trip just to pick this up.
    if (liveField.length) {
      const amateurSet = new Set(parsed.map((n) => n.toLowerCase()));
      setLiveField((prev) =>
        computeRanks(
          prev.map((p) => ({ ...p, isAmateur: amateurSet.has(p.name.toLowerCase()) }))
        )
      );
    }
  };

  const chooseEvent = (id, name) => {
    setEventId(id);
    setTournamentName(name);
    saveTournamentInfo(payouts, id, name);
    setEventOptions([]);
    setTimeout(fetchLive, 0);
  };

  const resetAllPicks = async () => {
    if (!resetArmed) {
      setResetArmed(true);
      setResetNotice(`Click again to confirm -- this clears every friend's ${pickCount} picks.`);
      setTimeout(() => setResetArmed(false), 5000);
      return;
    }
    setResetArmed(false);
    const blank = Array(pickCount).fill("");
    try {
      for (const f of friends) {
        await kvSet(k(`picks:${normalizeName(f)}`), JSON.stringify(blank));
      }
      const cleared = {};
      friends.forEach((f) => { cleared[f] = blank; });
      setAllPicks(cleared);
      if (activeFriend) setPicksDraft(blank);
      setResetNotice("All picks cleared for the new week.");
      setTimeout(() => setResetNotice(""), 3000);
    } catch {
      setResetNotice("Couldn't clear picks. Try again.");
    }
  };

  const results = useMemo(() => {
    if (!liveField.length || !payouts.length) return [];
    const byName = new Map(liveField.map((p) => [normalizeName(p.name), p]));
    const weights = weightsFor(pickCount);
    return Object.entries(allPicks)
      .map(([friend, picks]) => {
        let total = 0;
        const rows = picks.map((golfer, i) => {
          const weight = i < weights.length ? weights[i] : 0;
          const match = golfer ? byName.get(normalizeName(golfer)) : null;
          const isAmateurPick = !!(match && match.isAmateur);
          const prize = match && !isAmateurPick ? averagedPrize(match.rank, match.tieCount, payouts) : 0;
          const adjusted = prize * weight;
          total += adjusted;
          return {
            golfer,
            score: match ? match.scoreDisplay : null,
            rank: match ? match.rank : null,
            tieCount: match ? match.tieCount : 0,
            isAmateurPick,
            prize,
            adjusted,
            weight,
          };
        });
        return { friend, total, rows };
      })
      .sort((a, b) => b.total - a.total);
  }, [allPicks, liveField, payouts, pickCount]);

  const tabBtn = (id, label) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: "10px 18px",
        border: "none",
        background: "transparent",
        fontFamily: "'Fraunces', serif",
        fontSize: 15,
        fontWeight: tab === id ? 600 : 400,
        color: tab === id ? "#1B3A2F" : "#8A8368",
        borderBottom: tab === id ? "2px solid #B8912F" : "2px solid transparent",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: "#F6F1E4", color: "#24221C", minHeight: "100vh", padding: "0 0 3rem" }}>
      <div style={{ background: "#1B3A2F", padding: "2rem 2rem 1.25rem", borderBottom: "4px solid #B8912F" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ color: "#C9BFA0", fontSize: 12, letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>
              {poolLabel || "The pool"}
            </div>
            <h1 style={{ fontFamily: "'Fraunces', serif", color: "#F6F1E4", fontSize: 32, fontWeight: 700, margin: 0 }}>
              {tournamentName || "This week's tournament"}
            </h1>
          </div>
          <button
            onClick={onLeavePool}
            style={{ border: "none", background: "none", color: "#C9BFA0", fontSize: 13, cursor: "pointer", textDecoration: "underline", padding: 0 }}
          >
            All pools
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "0 2rem" }}>
        <div style={{ display: "flex", gap: 8, borderBottom: "1px solid #C9BFA0", marginTop: "1rem" }}>
          {tabBtn("picks", "My picks")}
          {tabBtn("leaderboard", "Leaderboard")}
          {tabBtn("setup", "Setup")}
        </div>

        {!loaded && <p style={{ color: "#8A8368", marginTop: "2rem" }}>Loading...</p>}

        {loaded && tab === "picks" && (
          <div style={{ marginTop: "2rem" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: "1.5rem" }}>
              <label style={{ fontSize: 14, color: "#5B5641" }}>You are:</label>
              <select
                value={activeFriend}
                onChange={(e) => setActiveFriend(e.target.value)}
                style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #C9BFA0", background: "#fff", fontSize: 14 }}
              >
                <option value="">Select your name</option>
                {friends.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <input
                placeholder="Add new name"
                value={newFriend}
                onChange={(e) => setNewFriend(e.target.value)}
                disabled={picksLocked}
                style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #C9BFA0", fontSize: 14, opacity: picksLocked ? 0.5 : 1 }}
              />
              <button
                onClick={addFriend}
                disabled={picksLocked}
                style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #1B3A2F", background: picksLocked ? "#8A8368" : "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: picksLocked ? "default" : "pointer" }}
              >
                Add
              </button>
            </div>

            {picksLocked && (
              <div style={{ background: "#FAECE7", border: "1px solid #F0997B", color: "#712B13", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: "1.5rem" }}>
                Picks are locked for this pool right now -- nobody can add themselves or change picks until it's unlocked on Setup.
              </div>
            )}

            {activeFriend ? (
              <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
                <p style={{ fontSize: 13, color: "#8A8368", marginTop: 0 }}>
                  Rank your {pickCount} golfers, 1 (most confident) to {pickCount}. Start typing to pick from this week's field.
                </p>
                {fieldNames.length === 0 && loadingLive && (
                  <p style={{ fontSize: 12, color: "#5B5641", marginTop: -6 }}>Loading this week's field from ESPN...</p>
                )}
                {fieldNames.length === 0 && !loadingLive && liveError && (
                  <p style={{ fontSize: 12, color: "#993C1D", marginTop: -6 }}>
                    Field list failed to load: {liveError}{" "}
                    <button type="button" onClick={fetchLive} style={{ border: "none", background: "none", color: "#993C1D", textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 12 }}>Retry</button>
                  </p>
                )}
                <datalist id="field-names">
                  {fieldNames.map((n) => <option key={n} value={n} />)}
                </datalist>
                {picksDraft.map((val, i) => {
                  const trimmed = val.trim();
                  const exact = trimmed && fieldNames.some((n) => normalizeName(n) === normalizeName(trimmed));
                  const suggestion = trimmed && !exact && fieldNames.length ? bestFuzzyMatch(trimmed, fieldNames) : null;
                  const noMatch = trimmed && !exact && fieldNames.length && !suggestion;
                  return (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, width: 28, color: "#B8912F", fontWeight: 600 }}>{i + 1}</span>
                        <input
                          value={val}
                          list="field-names"
                          disabled={picksLocked}
                          onChange={(e) => {
                            const next = [...picksDraft];
                            next[i] = e.target.value;
                            setPicksDraft(next);
                          }}
                          style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${noMatch || suggestion ? "#EF9F27" : "#E1DAC4"}`, fontSize: 14, opacity: picksLocked ? 0.6 : 1 }}
                        />
                      </div>
                      {suggestion && (
                        <div style={{ marginLeft: 38, marginTop: 4, fontSize: 12, color: "#854F0B" }}>
                          Not in this week's field. Did you mean{" "}
                          <button type="button" onClick={() => { const next = [...picksDraft]; next[i] = suggestion; setPicksDraft(next); }} style={{ border: "none", background: "none", color: "#854F0B", fontWeight: 600, textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 12 }}>{suggestion}</button>?
                        </div>
                      )}
                      {noMatch && <div style={{ marginLeft: 38, marginTop: 4, fontSize: 12, color: "#993C1D" }}>Not found in this week's field -- double check the spelling.</div>}
                    </div>
                  );
                })}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: "1rem" }}>
                  <button
                    onClick={savePicks}
                    disabled={picksLocked}
                    style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: picksLocked ? "#8A8368" : "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: picksLocked ? "default" : "pointer" }}
                  >
                    Save picks
                  </button>
                  {savedNotice && <span style={{ fontSize: 13, color: "#5B5641" }}>{savedNotice}</span>}
                </div>
              </div>
            ) : (
              <p style={{ color: "#8A8368" }}>Pick your name above (or add it) to enter your 15.</p>
            )}
          </div>
        )}

        {loaded && tab === "leaderboard" && (
          <div style={{ marginTop: "2rem" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: "1.5rem" }}>
              <button
                onClick={fetchLive}
                disabled={loadingLive}
                style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: loadingLive ? "#8A8368" : "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: loadingLive ? "default" : "pointer" }}
              >
                {loadingLive ? "Fetching..." : "Refresh live results"}
              </button>
              {liveField.length > 0 && <span style={{ fontSize: 13, color: "#5B5641" }}>{liveField.length} golfers loaded</span>}
            </div>

            {liveError && (
              <div style={{ background: "#FAECE7", border: "1px solid #F0997B", color: "#712B13", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: "1.5rem" }}>{liveError}</div>
            )}
            {!payouts.length && (
              <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", color: "#633806", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: "1.5rem" }}>
                No payout table set yet. Add this week's prize money by position on the Setup tab first.
              </div>
            )}
            {results.length > 0 && results.some((r) => r.rows.some((row) => row.golfer && !row.rank && !row.isAmateurPick)) && (
              <div style={{ background: "#FCEBEB", border: "1px solid #F09595", color: "#791F1F", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: "1.5rem" }}>
                Some picks don't match anyone in the live field, so they're currently scoring as $0. Open a name below to see which.
              </div>
            )}

            {results.length > 0 && (
              <div style={{ background: "#14140F", borderRadius: 10, padding: "1.5rem", marginBottom: "2rem" }}>
                {results.map((r, i) => (
                  <div key={r.friend} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px", borderBottom: i < results.length - 1 ? "1px solid #2B2A22" : "none" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#E7C368", fontSize: 15, width: 24 }}>{i + 1}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#F6F1E4", fontSize: 16, letterSpacing: 1 }}>{r.friend.toUpperCase()}</span>
                    </div>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#E7C368", fontSize: 17, fontWeight: 600 }}>{money(r.total)}</span>
                  </div>
                ))}
              </div>
            )}

            <details style={{ marginBottom: "1.5rem", background: "#fff", border: "1px solid #C9BFA0", borderRadius: 8, padding: "8px 14px" }}>
              <summary style={{ cursor: "pointer", fontFamily: "'Fraunces', serif", fontSize: 15, padding: "6px 0" }}>Leaderboard</summary>
              {tournamentLeaderboard.length === 0 ? (
                <p style={{ fontSize: 13, color: "#8A8368" }}>No live field loaded yet.</p>
              ) : (
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table style={{ width: "100%", minWidth: 400, fontSize: 13, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "#8A8368", textAlign: "left" }}>
                        <th style={{ padding: "4px 6px" }}>Position</th>
                        <th style={{ padding: "4px 6px" }}>Player</th>
                        <th style={{ padding: "4px 6px" }}>Score</th>
                        <th style={{ padding: "4px 6px" }}>Thru</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tournamentLeaderboard.map((p, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #EFEADA" }}>
                          <td style={{ padding: "4px 6px" }}>
                            {p.displayRank ? `${p.tieCountDisplay > 1 ? "T" : ""}${p.displayRank}` : "--"}
                          </td>
                          <td style={{ padding: "4px 6px" }}>
                            {p.name}
                            {p.isAmateur && <span style={{ color: "#854F0B", marginLeft: 6, fontSize: 11 }}>(a)</span>}
                          </td>
                          <td style={{ padding: "4px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{p.scoreDisplay || "--"}</td>
                          <td style={{ padding: "4px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{p.thru || "--"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>

            {results.map((r) => (
              <details key={r.friend} style={{ marginBottom: 10, background: "#fff", border: "1px solid #C9BFA0", borderRadius: 8, padding: "8px 14px" }}>
                <summary style={{ cursor: "pointer", fontFamily: "'Fraunces', serif", fontSize: 15, padding: "6px 0" }}>{r.friend} -- {money(r.total)}</summary>
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table style={{ width: "100%", minWidth: 480, fontSize: 13, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: "#8A8368", textAlign: "left" }}>
                      <th style={{ padding: "4px 6px" }}>Pick</th>
                      <th style={{ padding: "4px 6px" }}>Golfer</th>
                      <th style={{ padding: "4px 6px" }}>Score</th>
                      <th style={{ padding: "4px 6px" }}>Position</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>Prize</th>
                      <th style={{ padding: "4px 6px" }}>Weight</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>Adjusted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((row, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #EFEADA" }}>
                        <td style={{ padding: "4px 6px" }}>{i + 1}</td>
                        <td style={{ padding: "4px 6px", color: row.golfer && !row.rank && !row.isAmateurPick ? "#993C1D" : "inherit" }}>
                          {row.golfer || "--"}
                          {row.golfer && !row.rank && !row.isAmateurPick && <span style={{ display: "block", fontSize: 11 }}>no match in live field</span>}
                          {row.isAmateurPick && <span style={{ display: "block", fontSize: 11, color: "#854F0B" }}>amateur -- no prize money</span>}
                        </td>
                        <td style={{ padding: "4px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{row.score || "--"}</td>
                        <td style={{ padding: "4px 6px" }}>{row.rank ? `${row.tieCount > 1 ? "T" : ""}${row.rank}` : "--"}</td>
                        <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{money(row.prize)}</td>
                        <td style={{ padding: "4px 6px" }}>{Math.round(row.weight * 100)}%</td>
                        <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{money(row.adjusted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </details>
            ))}
          </div>
        )}

        {loaded && tab === "setup" && !setupUnlocked && (
          <div style={{ marginTop: "2rem", maxWidth: 340 }}>
            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Setup is locked</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>Enter the passcode to change tournament and payout settings.</p>
              <input
                type="password"
                value={passcodeInput}
                onChange={(e) => { setPasscodeInput(e.target.value); setPasscodeError(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (passcodeInput === SETUP_PASSCODE) setSetupUnlocked(true);
                    else setPasscodeError("That's not it.");
                  }
                }}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", marginBottom: 10 }}
              />
              <button
                onClick={() => { if (passcodeInput === SETUP_PASSCODE) setSetupUnlocked(true); else setPasscodeError("That's not it."); }}
                style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}
              >
                Unlock
              </button>
              {passcodeError && <p style={{ fontSize: 13, color: "#993C1D", marginTop: 10 }}>{passcodeError}</p>}
            </div>
          </div>
        )}

        {loaded && tab === "setup" && setupUnlocked && (
          <div style={{ marginTop: "2rem", display: "grid", gap: "1.5rem" }}>
            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Tournament</h3>
              <label style={{ fontSize: 13, color: "#5B5641", display: "block", marginBottom: 4 }}>Name (optional, auto-fills from ESPN)</label>
              <input
                value={tournamentName}
                onChange={(e) => setTournamentName(e.target.value)}
                onBlur={() => saveTournamentInfo(payouts)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", marginBottom: 12 }}
              />
              <label style={{ fontSize: 13, color: "#5B5641", display: "block", marginBottom: 4 }}>ESPN event ID (leave blank only on weeks with a single PGA Tour event)</label>
              <input
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                onBlur={() => saveTournamentInfo(payouts)}
                placeholder="e.g. 401811957"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", marginBottom: 12 }}
              />
              <label style={{ fontSize: 13, color: "#5B5641", display: "block", marginBottom: 4 }}>
                How many picks per person? (weights spread evenly from 100% to 30% across however many you set)
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={pickCount}
                onChange={(e) => setPickCount(Math.max(1, parseInt(e.target.value, 10) || DEFAULT_PICK_COUNT))}
                onBlur={() => saveTournamentInfo(payouts, eventId, tournamentName, pickCount)}
                style={{ width: 100, padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4" }}
              />
              <p style={{ fontSize: 12, color: "#8A8368", marginTop: 6, marginBottom: 0 }}>
                Changing this after people have already saved picks doesn't resize their existing picks -- any of their
                picks past the new count just stop counting toward their total, rather than being deleted.
              </p>
              {eventOptions.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ fontSize: 13, color: "#993C1D", marginBottom: 6 }}>Multiple PGA Tour events are live right now -- choose the one your pool is tracking:</p>
                  {eventOptions.map((ev) => (
                    <button key={ev.id} onClick={() => chooseEvent(ev.id, ev.name)} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", marginBottom: 6, borderRadius: 6, border: "1px solid #C9BFA0", background: "#F6F1E4", cursor: "pointer", fontSize: 14 }}>
                      {ev.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({ev.id})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Lock picks</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>
                When locked, nobody can add themselves or change any picks -- useful once the tournament actually starts,
                so no one can sneak a change after seeing early results. Setup stays reachable to you either way.
              </p>
              <button
                onClick={togglePicksLocked}
                style={{
                  padding: "10px 18px",
                  borderRadius: 6,
                  border: `1px solid ${picksLocked ? "#993C1D" : "#1B3A2F"}`,
                  background: picksLocked ? "#993C1D" : "#1B3A2F",
                  color: "#F6F1E4",
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                {picksLocked ? "Picks are locked -- click to unlock" : "Picks are open -- click to lock"}
              </button>
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Prize money by finish</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>Paste one amount per line, in finish order. Extra text on a line is fine -- only the last number is used.</p>
              <textarea
                value={payoutsText}
                onChange={(e) => setPayoutsText(e.target.value)}
                rows={10}
                placeholder={"4500000\n2430000\n1532530\n..."}
                style={{ width: "100%", padding: 10, borderRadius: 6, border: "1px solid #E1DAC4", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}
              />
              <button onClick={applyPayouts} style={{ marginTop: 10, padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}>Save payout table</button>
              {payouts.length > 0 && <span style={{ marginLeft: 12, fontSize: 13, color: "#5B5641" }}>{payouts.length} positions saved</span>}
              {payouts.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, color: "#5B5641" }}>
                    Show numbered list (verify positions lined up correctly)
                  </summary>
                  <div style={{ marginTop: 8, maxHeight: 240, overflowY: "auto", border: "1px solid #EFEADA", borderRadius: 6 }}>
                    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace" }}>
                      <tbody>
                        {payouts.map((amount, i) => (
                          <tr key={i} style={{ borderTop: i > 0 ? "1px solid #F1EEE0" : "none" }}>
                            <td style={{ padding: "4px 10px", color: "#8A8368", width: 50 }}>{i + 1}</td>
                            <td style={{ padding: "4px 10px", textAlign: "right" }}>{money(amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Amateurs this week</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>
                ESPN's data doesn't flag amateur status anywhere -- confirmed by directly inspecting a real amateur's full
                record during testing, nothing marks it. So this has to be entered manually: one full name per line,
                matching ESPN's spelling exactly (check the Leaderboard tab after a refresh if you're not sure how they're
                spelled). Leave blank on weeks with no amateurs in the field -- most weeks, this card does nothing.
              </p>
              <textarea
                value={amateursText}
                onChange={(e) => setAmateursText(e.target.value)}
                rows={4}
                placeholder={"Nevill Ruiter\nMason Howell\n..."}
                style={{ width: "100%", padding: 10, borderRadius: 6, border: "1px solid #E1DAC4", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}
              />
              <button onClick={applyAmateurs} style={{ marginTop: 10, padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}>Save amateur list</button>
              {amateurs.length > 0 && <span style={{ marginLeft: 12, fontSize: 13, color: "#5B5641" }}>{amateurs.length} marked</span>}
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Manage friends</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>
                Remove someone who was added by mistake, a duplicate, or dropped out. This deletes their picks too --
                not just their name.
              </p>
              {friends.length === 0 && <p style={{ fontSize: 13, color: "#8A8368" }}>No one's added yet.</p>}
              {friends.length > 0 && (
                <div style={{ display: "grid", gap: 6 }}>
                  {friends.map((f) => (
                    <div key={f} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderRadius: 6, border: "1px solid #EFEADA" }}>
                      <span style={{ fontSize: 14 }}>{f}</span>
                      <button
                        onClick={() => removeFriend(f)}
                        style={{
                          padding: "4px 12px",
                          borderRadius: 6,
                          border: `1px solid ${removeArmed === f ? "#A32D2D" : "#C9BFA0"}`,
                          background: removeArmed === f ? "#A32D2D" : "#fff",
                          color: removeArmed === f ? "#fff" : "#993C1D",
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        {removeArmed === f ? "Confirm?" : "Remove"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>New week</h3>
              <p style={{ fontSize: 13, color: "#8A8368" }}>Clears everyone's 15 picks. Tournament name, event ID, and payout table are left alone.</p>
              <button
                onClick={resetAllPicks}
                style={{ padding: "10px 18px", borderRadius: 6, border: `1px solid ${resetArmed ? "#A32D2D" : "#993C1D"}`, background: resetArmed ? "#A32D2D" : "#fff", color: resetArmed ? "#fff" : "#993C1D", fontSize: 14, cursor: "pointer" }}
              >
                {resetArmed ? "Click again to confirm" : "Clear all picks for a new week"}
              </button>
              {resetNotice && <p style={{ fontSize: 13, color: "#5B5641", marginTop: 10 }}>{resetNotice}</p>}
            </div>

            <div style={{ background: "#F1EFE8", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.25rem", fontSize: 13, color: "#5B5641" }}>
              Live results come from an unofficial ESPN endpoint, relayed through this site's own Worker. It isn't a documented,
              guaranteed API -- for real money settlement, cross-check final numbers against ESPN's official leaderboard before paying out.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
