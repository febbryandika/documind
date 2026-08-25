"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

type Me = { id: string; email: string; name: string };

// Proves the whole chain from the browser: the session cookie set by the API on
// :3001 is sent back cross-origin by the typed RPC client, CORS allows it with
// credentials, and sessionMiddleware resolves it (SPEC §5, §14).
export function UserMenu() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const [me, setMe] = useState<Me | null>(null);
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;

    const controller = new AbortController();

    // Still a plain effect now that the QueryClientProvider exists: this is a
    // one-shot probe of the session, not server state any other component
    // reads, so there is nothing for a shared cache to deduplicate or reuse.
    api.me
      .$get({}, { init: { signal: controller.signal } })
      .then((res) => (res.ok ? res.json() : null))
      .then(setMe)
      .catch(() => {}); // aborted on unmount

    return () => controller.abort();
  }, [userId]);

  async function signOut() {
    await authClient.signOut();
    // The document cache outlives the session otherwise, so the next person to
    // sign in on this browser sees the previous account's documents until a
    // refetch lands. The API is correctly scoped either way — this is purely a
    // client-side leak, and it is why sign-out has to drop the whole cache.
    queryClient.clear();
    router.push("/sign-in");
    router.refresh();
  }

  // Requiring the fetched user to match the current session keeps the sign-out
  // clearing out of the effect body, and avoids flashing the previous account's
  // email for one render after switching users.
  if (!userId || me?.id !== userId) return null;

  return (
    <div className="ml-auto flex items-center gap-3">
      <span className="text-muted-foreground text-sm">{me.email}</span>
      <Button variant="ghost" size="sm" onClick={signOut}>
        Sign out
      </Button>
    </div>
  );
}
