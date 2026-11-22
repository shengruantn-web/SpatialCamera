import type { Metadata } from "next";
import SharedScene from "../../../../components/SharedScene";

// S8: the chrome-free view for <iframe> embeds. worker/share.ts checks the token, counts the view and
// sends `frame-ancestors *` for this route only.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shared scene · Spatial Camera", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ShareEmbedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedScene token={token} embed />;
}
