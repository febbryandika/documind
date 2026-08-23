import Link from "next/link";
import { UserMenu } from "@/components/user-menu";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center px-4">
        <Link href="/" className="font-semibold tracking-tight">
          DocuMind
        </Link>
        <UserMenu />
      </div>
    </header>
  );
}
