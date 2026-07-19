import { useState, useEffect, useCallback } from "react";
import { kvGet, kvSet } from "./api.js";
import { PASSCODE } from "./constants.js";

const ADMIN_UNLOCK_KEY = "admin-unlocked";

function slugify(label) {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || "pool"}-${suffix}`;
}

export default function PoolPicker({ onOpenPool }) {
  const [pools, setPools] = useState(null);
  const [newLabel, setNewLabel] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [adminUnlocked, setAdminUnlocked] = useState(
    () => window.localStorage.getItem(ADMIN_UNLOCK_KEY) === "1"
  );
  const [adminInput, setAdminInput] = useState("");
  const [adminError, setAdminError] = useState("");

  const tryUnlockAdmin = () => {
    if (adminInput === PASSCODE) {
      window.localStorage.setItem(ADMIN_UNLOCK_KEY, "1");
      setAdminUnlocked(true);
    } else {
      setAdminError("That's not it.");
    }
  };

  const [deleteArmed, setDeleteArmed] = useState(null); // slug currently awaiting confirm

  const deletePool = async (slug) => {
    if (deleteArmed !== slug) {
      setDeleteArmed(slug);
      setTimeout(() => setDeleteArmed((cur) => (cur === slug ? null : cur)), 4000);
      return;
    }
    setDeleteArmed(null);
    try {
      const updated = (pools || []).filter((p) => p.slug !== slug);
      await kvSet("pool-index", JSON.stringify(updated));
      setPools(updated);
    } catch {
      setError("Couldn't delete that pool. Try again.");
    }
  };

  const load = useCallback(async () => {
    try {
      const raw = await kvGet("pool-index");
      setPools(raw ? JSON.parse(raw) : []);
    } catch {
      setPools([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createPool = async () => {
    const label = newLabel.trim();
    const password = newPassword.trim();
    if (!label) return;
    setCreating(true);
    setError("");
    try {
      const slug = slugify(label);
      if (password) {
        await kvSet(`pool:${slug}:password`, password);
      }
      const existing = pools || [];
      const updated = [...existing, { slug, label, createdAt: new Date().toISOString(), hasPassword: !!password }];
      await kvSet("pool-index", JSON.stringify(updated));
      onOpenPool(slug, label);
    } catch (e) {
      setError("Couldn't create the pool. Try again.");
    }
    setCreating(false);
  };

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: "#F6F1E4", color: "#24221C", minHeight: "100vh" }}>
      <div style={{ background: "#1B3A2F", padding: "2rem 2rem 1.25rem", borderBottom: "4px solid #B8912F" }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <div style={{ color: "#C9BFA0", fontSize: 12, letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>toomajian.org</div>
          <h1 style={{ fontFamily: "'Fraunces', serif", color: "#F6F1E4", fontSize: 32, fontWeight: 700, margin: 0 }}>Golf pools</h1>
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "2rem" }}>
        {!adminUnlocked ? (
          <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem", marginBottom: "2rem", maxWidth: 340 }}>
            <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Start a new pool</h3>
            <p style={{ fontSize: 13, color: "#8A8368" }}>Passcode required.</p>
            <input
              type="password"
              value={adminInput}
              onChange={(e) => { setAdminInput(e.target.value); setAdminError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") tryUnlockAdmin(); }}
              placeholder="Passcode"
              style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", marginBottom: 10, boxSizing: "border-box" }}
            />
            <button
              onClick={tryUnlockAdmin}
              style={{ width: "100%", padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}
            >
              Unlock
            </button>
            {adminError && <p style={{ fontSize: 13, color: "#993C1D", marginTop: 10 }}>{adminError}</p>}
          </div>
        ) : (
          <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "1.5rem", marginBottom: "2rem" }}>
            <h3 style={{ fontFamily: "'Fraunces', serif", marginTop: 0 }}>Start a new pool</h3>
            <p style={{ fontSize: 13, color: "#8A8368" }}>
              One pool per group, per tournament -- e.g. "College friends -- US Open" or "Work league -- The Open".
              You'll get a link to send that group.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Pool name"
                style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", fontSize: 14 }}
              />
              <input
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Password (optional)"
                style={{ width: 160, padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", fontSize: 14 }}
              />
              <button
                onClick={createPool}
                disabled={creating}
                style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: creating ? "default" : "pointer" }}
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
            <p style={{ fontSize: 12, color: "#8A8368", marginTop: 8, marginBottom: 0 }}>
              Leave the password blank for an open pool. If set, anyone with the link still needs the password to get in --
              it's a light deterrent, not real security.
            </p>
            {error && <p style={{ fontSize: 13, color: "#993C1D", marginTop: 10 }}>{error}</p>}
          </div>
        )}

        <h3 style={{ fontFamily: "'Fraunces', serif" }}>Existing pools</h3>
        {pools === null && <p style={{ color: "#8A8368" }}>Loading...</p>}
        {pools !== null && pools.length === 0 && <p style={{ color: "#8A8368" }}>No pools yet -- create the first one above.</p>}
        {pools !== null && pools.length > 0 && (
          <div style={{ display: "grid", gap: 8 }}>
            {[...pools].reverse().map((p) => (
              <div key={p.slug} style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                <button
                  onClick={() => onOpenPool(p.slug, p.label)}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    padding: "12px 16px",
                    borderRadius: 8,
                    border: "1px solid #C9BFA0",
                    background: "#fff",
                    cursor: "pointer",
                    fontFamily: "'Fraunces', serif",
                    fontSize: 15,
                  }}
                >
                  {p.label}
                  {p.hasPassword && <span style={{ marginLeft: 8, fontSize: 12, color: "#8A8368" }}>&#128274;</span>}
                  <span style={{ display: "block", fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#8A8368", marginTop: 2 }}>
                    Created {new Date(p.createdAt).toLocaleDateString()}
                  </span>
                </button>
                {adminUnlocked && (
                  <button
                    onClick={() => deletePool(p.slug)}
                    title={deleteArmed === p.slug ? "Click again to confirm" : "Delete this pool"}
                    style={{
                      padding: "0 16px",
                      borderRadius: 8,
                      border: `1px solid ${deleteArmed === p.slug ? "#A32D2D" : "#C9BFA0"}`,
                      background: deleteArmed === p.slug ? "#A32D2D" : "#fff",
                      color: deleteArmed === p.slug ? "#fff" : "#993C1D",
                      fontSize: 13,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {deleteArmed === p.slug ? "Confirm?" : "Delete"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
