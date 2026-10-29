/**
 * The QA Checklist 2026 error levels — Breaking / Major / Minor — for each audit rule.
 * Rules not listed: error → Major, warning / info → Minor.
 */
export type Level = "Breaking" | "Major" | "Minor";

const TABLE: [RegExp, Level][] = [
  // General Site Settings & SEO — Breaking
  [/^(info-|text-|bizinfo-|fact-(phone|email|address|hours|name)|area-served|site-meta-|favicon|touch-icon|address-|phone-wrong|map-wrong)/, "Breaking"],
  [/^(requested-missing|nav-missing-request|nav-template-missing|nav-hidden-device|nav-request-hidden|nav-template-hidden|nav-basic-not-anchor|nav-anchor-missing|page-meta-|item-meta-)/, "Breaking"],
  [/^(title-|meta-|duplicate-title|duplicate-metaDescription|ai-title-location)/, "Breaking"],
  [/^(alt-(missing|no-business-name|double-word|filename)|item-alt|logo-alt)/, "Breaking"],
  [/^(broken-link|anchor-missing|link-|call-link|map-link|review-link|page-fetch)/, "Breaking"],
  [/^(userway-missing|review-count|contrast-wcag|text-invisible)/, "Breaking"],
  [/^(vehicle-not-serviced|item-vehicle-not-serviced|ai-review-other|review-other|placeholder|text-placeholder|item-placeholder|other-business|privacy-placeholder)/, "Breaking"],
  [/^(h1-missing|h1-multiple)/, "Breaking"],
  [/^(redirects-missing|redirect-target-missing)/, "Breaking"],
  // Major
  [/^(social-broken|foreign-duda-link|external-broken|booking-slug-placeholder|redirect-not-301)/, "Major"],
  [/^(site-label|lite-extra-pages|privacy-)/, "Major"],
  [/^(heading-duplicate-home|h1-|heading-skip|gbp-category)/, "Major"],
  [/^(cert-|coupon-|warranty-|faq-|form-|careers-|financing-|city-list-|template-image|stock-image|logo-|nav-not-requested|page-not-requested)/, "Major"],
  // Minor
  [/^(footer-font-small|heading-repeated|alt-(redundant|long|short|duplicate)|touch-icon-missing)/, "Minor"],
];

export function levelOf(f: { rule: string; severity: string }): Level {
  if (f.severity === "info") return "Minor";
  for (const [re, l] of TABLE) if (re.test(f.rule)) return l === "Breaking" && f.severity === "warning" ? "Major" : l;
  return f.severity === "error" ? "Major" : "Minor";
}
export const LEVELS: Level[] = ["Breaking", "Major", "Minor"];
