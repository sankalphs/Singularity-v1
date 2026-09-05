"use client";

import dynamic from "next/dynamic";
import { useParams, useSearchParams } from "next/navigation";

const GameClient = dynamic(() => import("@/components/GameClient"), { ssr: false });

export default function PlayPage() {
  const params = useParams<{ code: string }>();
  const search = useSearchParams();
  const code = String(params.code ?? "").toUpperCase();
  const solo = search.get("solo") === "1";
  return <GameClient code={code} solo={solo} />;
}
