import type { Metadata } from "next";
import SharedScene from "../../../components/SharedScene";

// S8: the public share page. worker/share.ts checks the token (and counts the view) before this renders.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shared scene · Spatial Camera", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedScene token={token} embed={false} />;
}
