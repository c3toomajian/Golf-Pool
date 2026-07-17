import { useState, useEffect } from "react";
import { kvGet } from "./api.js";

function unlockedKey(slug) {
  return `unlocked:${slug}`;
}

export default function PoolGate({ poolId, poolLabel, children }) {
  const [status, setStatus] = useState("checking"); // checking | open | locked | unlocked | error
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [realPassword, setRealPassword] = useState(null);

  const checkPassword = () => {
    setStatus("checking");
    kvGet(`pool:${poolId}:password`)
      .then((pw) => {
        if (!pw) {
          setStatus("open");
          return;
        }
        setRealPassword(pw);
        setStatus(window.localStorage.getItem(unlockedKey(poolId)) === "1" ? "unlocked" : "locked");
      })
      .catch(() => setStatus("error"));
  };

  useEffect(() => {
    checkPassword();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolId]);

  const tryUnlock = () => {
    if (input === realPassword) {
      window.localStorage.setItem(unlockedKey(poolId), "1");
      setStatus("unlocked");
    } else {
      setError("That's not it.");
    }
  };

  if (status === "checking") {
    return <div style={{ padding: "3rem", textAlign: "center", color: "#8A8368", fontFamily: "'Inter', sans-serif" }}>Loading...</div>;
  }

  if (status === "error") {
    return (
      <div style={{ padding: "3rem", textAlign: "center", fontFamily: "'Inter', sans-serif" }}>
        <p style={{ color: "#993C1D" }}>Couldn't check this pool's password right now.</p>
        <button onClick={checkPassword} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", cursor: "pointer" }}>
          Retry
        </button>
      </div>
    );
  }

  if (status === "open" || status === "unlocked") {
    return children;
  }

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: "#F6F1E4", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", border: "1px solid #C9BFA0", borderRadius: 10, padding: "2rem", maxWidth: 340, width: "100%" }}>
        <div style={{ color: "#8A8368", fontSize: 12, letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>Password protected</div>
        <h2 style={{ fontFamily: "'Fraunces', serif", marginTop: 0, marginBottom: 12 }}>{poolLabel || "This pool"}</h2>
        <input
          type="password"
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") tryUnlock(); }}
          placeholder="Password"
          style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #E1DAC4", marginBottom: 10, boxSizing: "border-box" }}
        />
        <button
          onClick={tryUnlock}
          style={{ width: "100%", padding: "10px 18px", borderRadius: 6, border: "1px solid #1B3A2F", background: "#1B3A2F", color: "#F6F1E4", fontSize: 14, cursor: "pointer" }}
        >
          Enter
        </button>
        {error && <p style={{ fontSize: 13, color: "#993C1D", marginTop: 10 }}>{error}</p>}
      </div>
    </div>
  );
}
