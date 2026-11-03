import type { OrderStatus } from '@prisma/client';
import { IllegalTransitionError, isTerminal, nextStatus, type OrderEvent } from './order-state';

describe('order state machine', () => {
  it.each<[OrderStatus, OrderEvent, boolean, OrderStatus]>([
    ['PENDING_NEW', 'accepted', false, 'OPEN'],
    ['PENDING_NEW', 'accepted', true, 'PENDING_TRIGGER'],
    ['PENDING_NEW', 'rejected', false, 'REJECTED'],
    ['PENDING_TRIGGER', 'stop_triggered', true, 'OPEN'],
    ['PENDING_TRIGGER', 'cancelled', true, 'CANCELLED'],
    ['OPEN', 'trade', false, 'PARTIALLY_FILLED'],
    ['OPEN', 'cancelled', false, 'CANCELLED'],
    ['OPEN', 'filled', false, 'FILLED'],
    ['PARTIALLY_FILLED', 'trade', false, 'PARTIALLY_FILLED'],
    ['PARTIALLY_FILLED', 'filled', false, 'FILLED'],
    ['PARTIALLY_FILLED', 'reduced', false, 'PARTIALLY_FILLED'],
  ])('%s --%s--> (stop=%s) %s', (from, event, isStop, to) => {
    expect(nextStatus(from, event, { isStop })).toBe(to);
  });

  it.each<[OrderStatus, OrderEvent]>([
    ['FILLED', 'trade'],
    ['CANCELLED', 'filled'],
    ['REJECTED', 'accepted'],
    ['PENDING_NEW', 'trade'],
    ['PENDING_TRIGGER', 'trade'],
    ['OPEN', 'accepted'],
    ['OPEN', 'stop_triggered'],
  ])('rejects %s --%s-->', (from, event) => {
    expect(() => nextStatus(from, event)).toThrow(IllegalTransitionError);
  });

  it('identifies terminal states', () => {
    expect(['FILLED', 'CANCELLED', 'REJECTED'].every((s) => isTerminal(s as OrderStatus))).toBe(
      true,
    );
    expect(isTerminal('PARTIALLY_FILLED')).toBe(false);
  });
});
