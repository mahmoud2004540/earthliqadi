'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Dictionary } from '@/i18n';
import { Button } from './ui/button';

/** Session-aware header actions (the header itself is statically rendered). */
export function HeaderAuth({ t }: { t: Dictionary['nav'] }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => {
        if (active) setSignedIn(res.ok);
      })
      .catch(() => {
        if (active) setSignedIn(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (signedIn === null) return <span className="h-8 w-40" aria-hidden />;
  if (signedIn) {
    return (
      <Button asChild size="sm" variant="secondary">
        <Link href="/dashboard">{t.dashboard}</Link>
      </Button>
    );
  }
  return (
    <>
      <Button asChild size="sm">
        <Link href="/connect">{t.connectWallet}</Link>
      </Button>
    </>
  );
}
