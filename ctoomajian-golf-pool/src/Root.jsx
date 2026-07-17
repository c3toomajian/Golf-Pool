import { useState, useEffect } from "react";
import App from "./App.jsx";
import PoolPicker from "./PoolPicker.jsx";
import PoolGate from "./PoolGate.jsx";

function getPoolFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return { slug: params.get("pool") || "", label: params.get("label") || "" };
}

export default function Root() {
  const [pool, setPool] = useState(getPoolFromUrl());

  useEffect(() => {
    const onPopState = () => setPool(getPoolFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const openPool = (slug, label) => {
    const url = `${window.location.pathname}?pool=${encodeURIComponent(slug)}&label=${encodeURIComponent(label)}`;
    window.history.pushState({}, "", url);
    setPool({ slug, label });
  };

  const leavePool = () => {
    window.history.pushState({}, "", window.location.pathname);
    setPool({ slug: "", label: "" });
  };

  if (!pool.slug) {
    return <PoolPicker onOpenPool={openPool} />;
  }
  return (
    <PoolGate poolId={pool.slug} poolLabel={pool.label}>
      <App poolId={pool.slug} poolLabel={pool.label} onLeavePool={leavePool} />
    </PoolGate>
  );
}
