import * as React from 'react';
import { cn } from '@/lib/utils';

export function Alert({
  tone = 'info',
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: 'info' | 'error' | 'success' | 'warning' }) {
  const tones = {
    info: 'border-primary/40 bg-primary/10 text-foreground',
    error: 'border-negative/40 bg-negative/10 text-negative',
    success: 'border-positive/40 bg-positive/10 text-positive',
    warning: 'border-warning/40 bg-warning/10 text-warning',
  } as const;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-md border px-4 py-3 text-sm', tones[tone], className)}
      {...props}
    />
  );
}
