'use client';

import type { CandleDto } from '@platform/shared';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';

const COLORS = { up: '#25C997', down: '#F05B67', text: '#8d9bb0', grid: '#1f2a37', bg: '#10151D' };

/**
 * Candlestick + volume chart. Converting decimal strings to numbers here is for
 * plotting only (ADR-0009); no money math happens in the chart.
 */
export function PriceChart({ candles, emptyLabel }: { candles: CandleDto[]; emptyLabel: string }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: COLORS.bg },
        textColor: COLORS.text,
        attributionLogo: true,
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: COLORS.grid },
      rightPriceScale: { borderColor: COLORS.grid },
    });
    candleSeries.current = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    volumeSeries.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const toTime = (iso: string) => Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;
    candleSeries.current?.setData(
      candles.map((c) => ({
        time: toTime(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      })),
    );
    volumeSeries.current?.setData(
      candles.map((c) => ({
        time: toTime(c.time),
        value: Number(c.volume),
        color: Number(c.close) >= Number(c.open) ? `${COLORS.up}66` : `${COLORS.down}66`,
      })),
    );
  }, [candles]);

  return (
    <div className="relative h-full min-h-[320px] w-full">
      <div ref={container} className="absolute inset-0" data-testid="price-chart" />
      {candles.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}
