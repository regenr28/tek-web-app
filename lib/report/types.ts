/** Everything a history report needs — built once in the page, then turned into a PDF or an Excel file. */
export type ReportSeries = { label: string; color: string; /** short name for line-end labels */ short?: string };
export type ReportSite = {
  name: string; domain: string; status: string; created: Date | null; firstPublished: Date | null; unpublished: Date | null; estimated: boolean; now: string;
  inCreated: boolean; inPublished: boolean; inUnpublished: boolean;
};
export type ReportData = {
  title: string;
  /** e.g. "Monthly · Nov 2025 – Oct 2026" */
  subtitle: string;
  /** active page filters, "" = none */
  filters: string;
  generated: Date;
  unitLabel: string;
  series: ReportSeries[];
  buckets: { label: string; start: Date; values: number[] }[];
  totals: number[];
  /** the last period isn't over yet */
  partialLast: boolean;
  /** "so far" (period still running) or "partial" (cut short by a custom end date) */
  partialWord?: string;
  breakdownTitle: string;
  breakdown: { label: string; value: number; color: string }[];
  notes: string[];
  sites: ReportSite[];
};
