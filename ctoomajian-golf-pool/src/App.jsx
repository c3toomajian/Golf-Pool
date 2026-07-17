import { useState, useEffect, useCallback, useMemo } from "react";
import { kvGet, kvSet, espnScoreboard, espnSummary } from "./api.js";

const SETUP_PASSCODE = "PercivalToots";
const WEIGHTS = Array.from({ length: 15 }, (_, i) => 1 - i * 0.05); // 1.00 -> 0.30

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

function findCompetitorArray(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    if (node.length && node.every((it) => it && typeof it === "object" && "athlete" in it)) {
      return node;
    }
    for (const item of node) {
      const found = findCompetitorArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const key of Object.keys(node)) {
      const found = findCompetitorArray(node[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findEventName(node, depth = 0) {
  if (!node || depth > 4 || typeof node !== "object") return null;
  if (typeof node.name === "string" && !Array.isArray(node)) return node.name;
  if (Array.isArray(node.events) && node.events[0] && node.events[0].name) return node.events[0].name;
  return null;
}

function thruFromCompetitor(c) {
  if (!c.linescores || !c.linescores.length) return "-";
  const lastRound = c.linescores[c.linescores.length - 1];
  const holes = lastRound.linescores ? lastRound.linescores.length : null;
  if (holes === null || holes >= 18) return "F";
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
  const [picksDraft, setPicksDraft] = useState(Array(15).fill(""));
  const [allPicks, setAllPicks] = useState({});
  const [tournamentName, setTournamentName] = useState("");
  const [eventId, setEventId] = useState("");
  const [payoutsText, setPayoutsText] = useState("");
  const [payouts, setPayouts] = useState([]);
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
    try {
      const friendsRaw = await kvGet(k("friends"));
      const friendList = friendsRaw ? JSON.parse(friendsRaw) : [];
      setFriends(friendList);

      const picksMap = {};
      for (const f of friendList) {
        const raw = await kvGet(k(`picks:${normalizeName(f)}`));
        picksMap[f] = raw ? JSON.parse(raw) : Array(15).fill("");
      }
      setAllPicks(picksMap);

      const infoRaw = await kvGet(k("tournament-info"));
      if (infoRaw) {
        const info = JSON.parse(infoRaw);
        setTournamentName(info.name || "");
        setEventId(info.eventId || "");
        setPayouts(info.payouts || []);
        setPayoutsText((info.payouts || []).join("\n"));
      }
    } catch (e) {
      // fine on first run, nothing saved yet
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (activeFriend && allPicks[activeFriend]) {
      setPicksDraft(allPicks[activeFriend]);
    } else {
      setPicksDraft(Array(15).fill(""));
    }
  }, [activeFriend, allPicks]);

  const applyCompetitors = (competitors) => {
    const parsed = competitors
      .map((c) => {
        const rawName = (c.athlete && (c.athlete.displayName || c.athlete.fullName)) || "";
        const isAmateur = /\(a\)\s*$/i.test(rawName.trim());
        const name = rawName.replace(/\(a\)\s*$/i, "").trim();
        return {
          name,
          isAmateur,
          scoreNum: parseScoreToNumber(c.score),
          thru: thruFromCompetitor(c),
        };
      })
      .filter((p) => p.name);
    setLiveField(computeRanks(parsed));
  };

  const saveTournamentInfo = async (nextPayouts, nextEventId = eventId, nextName = tournamentName) => {
    try {
      await kvSet(k("tournament-info"), JSON.stringify({ name: nextName, eventId: nextEventId, payouts: nextPayouts }));
    } catch {}
  };

  const fetchLive = useCallback(async () => {
    setLoadingLive(true);
    setLiveError("");
    setEventOptions([]);
    try {
      if (eventId.trim()) {
        const data = await espnSummary(eventId.trim());
        const competitors = findCompetitorArray(data);
        if (!competitors) throw new Error("Couldn't find a leaderboard for that event ID.");
        applyCompetitors(competitors);
        const evName = findEventName(data);
        if (evName && !tournamentName) {
          setTournamentName(evName);
          saveTournamentInfo(payouts, eventId, evName);
        }
      } else {
        const data = await espnScoreboard();
        const events = Array.isArray(data.events) ? data.events : [];
        if (events.length === 0) {
          throw new Error("ESPN isn't showing any live PGA Tour event right now.");
        } else if (events.length > 1) {
          setEventOptions(events.map((e) => ({ id: e.id, name: e.name })));
          setLiveError(
            `${events.length} PGA Tour events are live at once this week -- pick the right one on the Setup tab. Nothing was scored automatically since guessing wrong would silently attribute the wrong tournament's prize money.`
          );
        } else {
          const competition = events[0].competitions && events[0].competitions[0];
          const competitors = competition && competition.competitors;
          if (!competitors) throw new Error("Couldn't find a leaderboard in ESPN's response.");
          applyCompetitors(competitors);
          if (events[0].name && !tournamentName) {
            setTournamentName(events[0].name);
            saveTournamentInfo(payouts, eventId, events[0].name);
          }
        }
      }
    } catch (e) {
      setLiveError(`Couldn't load live results (${e.message}). Nothing was substituted, so scores reflect the last successful fetch only.`);
    }
    setLoadingLive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, tournamentName, payouts]);

  useEffect(() => {
    if (loaded && liveField.length === 0) fetchLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const fieldNames = useMemo(
    () => Array.from(new Set(liveField.map((p) => (p.isAmateur ? `${p.name} (a)` : p.name)))).sort(),
    [liveField]
  );

  const addFriend = async () => {
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

  const savePicks = async () => {
    if (!activeFriend) return;
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
      setResetNotice("Click again to confirm -- this clears every friend's 15 picks.");
      setTimeout(() => setResetArmed(false), 5000);
      return;
    }
    setResetArmed(false);
    const blank = Array(15).fill("");
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
    return Object.entries(allPicks)
      .map(([friend, picks]) => {
        let total = 0;
        const rows = picks.map((golfer, i) => {
          const match = golfer ? byName.get(normalizeName(golfer)) : null;
          const isAmateurPick = !!(match && match.isAmateur);
          const prize = match && !isAmateurPick ? averagedPrize(match.rank, match.tieCount, payouts) : 0;
          const adjusted = prize * WEIGHTS[i];
          total += adjusted;
          return {
            golfer,
            rank: match ? match.rank : null,
            tieCount: match ? match.tieCount : 0,
            isAmateurPick,
            prize,
            adjusted,
            weight: WEIGHTS[i],
          };
        });
        return { friend, total, rows };
      })
      .sort((a, b) => b.total - a.total);
  }, [allPicks, liveField, payouts]);

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
                style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #C9BFA0", fontSize: 14 }}
              />
              <button
                onClick={addFriend}
                style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}
              >
                Add
              </button>
            </div>

            {activeFriend ? (
              <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem" }}>
                <p style={{ fontSize: 13, color: "#8A8368", marginTop: 0 }}>
                  Rank your 15 golfers, 1 (most confident) to 15. Start typing to pick from this week's field.
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
                          onChange={(e) => {
                            const next = [...picksDraft];
                            next[i] = e.target.value;
                            setPicksDraft(next);
                          }}
                          style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: `1px solid ${noMatch || suggestion ? "#EF9F27" : "#E1DAC4"}`, fontSize: 14 }}
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
                  <button onClick={savePicks} style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}>Save picks</button>
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

            {results.map((r) => (
              <details key={r.friend} style={{ marginBottom: 10, background: "#fff", border: "1px solid #C9BFA0", borderRadius: 8, padding: "8px 14px" }}>
                <summary style={{ cursor: "pointer", fontFamily: "'Fraunces', serif", fontSize: 15, padding: "6px 0" }}>{r.friend} -- {money(r.total)}</summary>
                <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginTop: 8 }}>
                  <thead>
                    <tr style={{ color: "#8A8368", textAlign: "left" }}>
                      <th style={{ padding: "4px 6px" }}>Pick</th>
                      <th style={{ padding: "4px 6px" }}>Golfer</th>
                      <th style={{ padding: "4px 6px" }}>Finish</th>
                      <th style={{ padding: "4px 6px" }}>Weight</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>Credit</th>
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
                        <td style={{ padding: "4px 6px" }}>{row.rank ? `${row.tieCount > 1 ? "T" : ""}${row.rank}` : "--"}</td>
                        <td style={{ padding: "4px 6px" }}>{Math.round(row.weight * 100)}%</td>
                        <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{money(row.adjusted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4" }}
              />
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
