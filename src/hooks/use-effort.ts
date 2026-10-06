import { useEffect, useState } from "react";
import type { Effort } from "@/components/kit";

export function useEffort(): [Effort, (e: Effort) => void] {
  const [e, setE] = useState<Effort>("normal");
  useEffect(() => {
    const v = localStorage.getItem("mirza-effort");
    if (v === "advanced" || v === "normal") setE(v);
  }, []);
  return [
    e,
    (v) => {
      setE(v);
      localStorage.setItem("mirza-effort", v);
    },
  ];
}
