import type { OrderStatus } from '@prisma/client';

/** Engine event types that change an order (ADR-0007 state machine). */
export type OrderEvent =
  'accepted' | 'rejected' | 'stop_triggered' | 'trade' | 'filled' | 'cancelled' | 'reduced';

export class IllegalTransitionError extends Error {
  constructor(from: OrderStatus, event: OrderEvent) {
    super(`Illegal order transition: ${from} --${event}-->`);
    this.name = 'IllegalTransitionError';
  }
}

const TERMINAL: ReadonlySet<OrderStatus> = new Set(['FILLED', 'CANCELLED', 'REJECTED']);

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Returns the next status, or throws for any transition the state machine does
 * not allow (settlement stops rather than guessing).
 */
export function nextStatus(
  from: OrderStatus,
  event: OrderEvent,
  ctx: { isStop?: boolean } = {},
): OrderStatus {
  switch (from) {
    case 'PENDING_NEW':
      if (event === 'accepted') return ctx.isStop ? 'PENDING_TRIGGER' : 'OPEN';
      if (event === 'rejected') return 'REJECTED';
      break;
    case 'PENDING_TRIGGER':
      if (event === 'stop_triggered') return 'OPEN';
      if (event === 'cancelled') return 'CANCELLED';
      if (event === 'reduced') return 'PENDING_TRIGGER';
      break;
    case 'OPEN':
    case 'PARTIALLY_FILLED':
      if (event === 'trade') return 'PARTIALLY_FILLED';
      if (event === 'filled') return 'FILLED';
      if (event === 'cancelled') return 'CANCELLED';
      if (event === 'reduced') return from;
      break;
    default:
      break;
  }
  throw new IllegalTransitionError(from, event);
}
