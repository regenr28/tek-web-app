import { zip } from "./zip";
import type { ReportData } from "./types";
import { CREATOR, CREDIT, DEFAULT_APP_NAME } from "../credit";

/**
 * Excel report (.xlsx) written by hand: Summary sheet with KPI tiles, tables and native Excel charts (line + doughnut),
 * a "By period" table and a "Sites" list. No dependencies — Excel, Google Sheets, Numbers and LibreOffice open it.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const col = (i: number) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const hex6 = (c: string) => c.replace("#", "").toUpperCase();
const serial = (d: Date) => d.getTime() / 86_400_000 + 25569;

/** Style ids (cellXfs order below). */
const S = { def: 0, title: 1, muted: 2, head: 3, int: 4, text: 5, pct: 6, totText: 7, totInt: 8, date: 9, kpiNum: 10, kpiLbl: 11, headR: 12, note: 13, totPct: 14, section: 15 };
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="mmm d, yyyy"/></numFmts>
<fonts count="7">
<font><sz val="11"/><color rgb="FF16181D"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF16181D"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="18"/><color rgb="FF16181D"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF636B78"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="22"/><color rgb="FF16181D"/><name val="Calibri"/><family val="2"/></font>
<font><i/><sz val="9"/><color rgb="FF636B78"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF3B5BDB"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E5EA"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="16">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="3" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="left"/></xf>
<xf numFmtId="3" fontId="5" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

type Cell = { v?: string | number | null; f?: string; s?: number } | null;
const c = (v: string | number | null | undefined, s = 0): Cell => ({ v: v ?? null, s });
const fx = (f: string, s = 0): Cell => ({ f, s });

function sheet(rows: Cell[][], o: { widths: number[]; heights?: Record<number, number>; merges?: string[]; freeze?: number; filter?: string; drawing?: boolean; landscape?: boolean; gridlines?: boolean }) {
  const body = rows.map((r, ri) => {
    const cells = r.map((cell, ci) => {
      if (!cell) return "";
      const ref = `${col(ci)}${ri + 1}`, s = cell.s ? ` s="${cell.s}"` : "";
      if (cell.f) return `<c r="${ref}"${s}><f>${esc(cell.f)}</f></c>`;
      if (cell.v === null || cell.v === undefined || cell.v === "") return cell.s ? `<c r="${ref}"${s}/>` : "";
      if (typeof cell.v === "number") return Number.isFinite(cell.v) ? `<c r="${ref}"${s}><v>${cell.v}</v></c>` : "";
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
    }).join("");
    const ht = o.heights?.[ri + 1];
    return `<row r="${ri + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ""}>${cells}</row>`;
  }).join("");
  const pane = o.freeze ? `<pane ySplit="${o.freeze}" topLeftCell="A${o.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${o.freeze + 1}" sqref="A${o.freeze + 1}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0"${o.gridlines === false ? ' showGridLines="0"' : ""}>${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="16"/>
<cols>${o.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${body}</sheetData>
${o.filter ? `<autoFilter ref="${o.filter}"/>` : ""}
${o.merges?.length ? `<mergeCells count="${o.merges.length}">${o.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : ""}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup orientation="${o.landscape === false ? "portrait" : "landscape"}" fitToWidth="1" fitToHeight="0"/>
${o.drawing ? '<drawing r:id="rId1"/>' : ""}
</worksheet>`;
}

const txPr = (sz: number, color = "636B78", bold = false) =>
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}"${bold ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const chartTitle = (t: string) =>
  `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1300" b="1"><a:solidFill><a:srgbClr val="16181D"/></a:solidFill></a:rPr><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
const strCache = (ref: string, vals: string[]) => `<c:strRef><c:f>${esc(ref)}</c:f><c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache></c:strRef>`;
const numCache = (ref: string, vals: number[], fmt = "General") => `<c:numRef><c:f>${esc(ref)}</c:f><c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("")}</c:numCache></c:numRef>`;
const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function lineChart(d: ReportData) {
  const n = d.buckets.length, last = n + 1;
  const cats = d.buckets.map((b, i) => (i === n - 1 && d.partialLast ? `${b.label} (${d.partialWord || "so far"})` : b.label));
  const sers = d.series.map((s, si) => `<c:ser><c:idx val="${si}"/><c:order val="${si}"/><c:tx><c:v>${esc(s.label)}</c:v></c:tx>
<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${hex6(s.color)}"/></a:solidFill><a:round/></a:ln></c:spPr>
<c:marker><c:symbol val="${n > 24 ? "none" : "circle"}"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${hex6(s.color)}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>
<c:cat>${strCache(`'By period'!$A$2:$A$${last}`, cats)}</c:cat>
<c:val>${numCache(`'By period'!$${col(2 + si)}$2:$${col(2 + si)}$${last}`, d.buckets.map((b) => b.values[si]))}</c:val><c:smooth val="0"/></c:ser>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace ${NS}><c:roundedCorners val="0"/><c:chart>${chartTitle(`${d.title} per ${d.unitLabel.toLowerCase()}`)}
<c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>
<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D0D4DB"/></a:solidFill></a:ln></c:spPr>${txPr(900)}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>
<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="ECEEF2"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900)}<c:crossAx val="5001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>
<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>
<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txPr(1000, "16181D")}</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>
<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>`;
}

function donutChart(d: ReportData, firstRow: number) {
  const k = d.breakdown.length, lastRow = firstRow + k - 1;
  const pts = d.breakdown.map((b, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${hex6(b.color)}"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace ${NS}><c:roundedCorners val="0"/><c:chart>${chartTitle(d.breakdownTitle)}
<c:plotArea><c:layout/><c:doughnutChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Sites</c:v></c:tx>${pts}
<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(1000, "16181D", true)}<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>
<c:cat>${strCache(`Summary!$A$${firstRow}:$A$${lastRow}`, d.breakdown.map((b) => b.label))}</c:cat>
<c:val>${numCache(`Summary!$B$${firstRow}:$B$${lastRow}`, d.breakdown.map((b) => b.value), "#,##0")}</c:val></c:ser>
<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>
<c:legend><c:legendPos val="r"/><c:overlay val="0"/>${txPr(1000, "16181D")}</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>
<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>`;
}

const anchor = (id: number, rid: string, from: [number, number], to: [number, number]) => `<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>${from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>${to[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id + 1}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;

export function buildXlsx(d: ReportData): Uint8Array {
  // ---- Summary ----
  const S1: Cell[][] = [];
  const merges: string[] = ["A1:C1", "A2:C2", "A3:C3", "A4:C4"];
  S1.push([c(d.title, S.title)]);
  S1.push([c(`${d.subtitle} · generated ${d.generated.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, S.muted)]);
  S1.push([c(d.filters ? `Filters: ${d.filters}` : "All websites (no filters)", S.muted)]);
  S1.push([c(`${d.appName || DEFAULT_APP_NAME} · ${CREDIT}`, S.muted)]);
  S1.push([]);
  S1.push(d.series.map((_, i) => c(d.totals[i], S.kpiNum)));
  S1.push(d.series.map((s) => c(s.label, S.kpiLbl)));
  S1.push([]);
  S1.push([c("Totals for the period", S.section)]);
  S1.push([c("Metric", S.head), c("Sites", S.headR)]);
  d.series.forEach((s, i) => S1.push([c(s.label, S.text), c(d.totals[i], S.int)]));
  S1.push([]);
  S1.push([c(d.breakdownTitle, S.section)]);
  S1.push([c("Where they are now", S.head), c("Sites", S.headR), c("Share", S.headR)]);
  const first = S1.length + 1;
  const sum = d.breakdown.reduce((n, b) => n + b.value, 0);
  d.breakdown.forEach((b, i) => S1.push([c(b.label, S.text), c(b.value, S.int), sum ? fx(`IF($B$${first + d.breakdown.length}=0,0,B${first + i}/$B$${first + d.breakdown.length})`, S.pct) : c(0, S.pct)]));
  S1.push([c("Total", S.totText), fx(`SUM(B${first}:B${first + d.breakdown.length - 1})`, S.totInt), fx(`SUM(C${first}:C${first + d.breakdown.length - 1})`, S.totPct)]);
  S1.push([]);
  const noteRow = S1.length + 1;
  d.notes.forEach((t, i) => { S1.push([c(t, S.note)]); merges.push(`A${noteRow + i}:C${noteRow + i}`); });
  const heights: Record<number, number> = { 1: 30, 5: 40, 6: 30 };
  d.notes.forEach((t, i) => { heights[noteRow + i] = Math.max(16, Math.ceil(t.length / 70) * 13); });

  // ---- By period ----
  const n = d.buckets.length;
  const S2: Cell[][] = [[c("Period", S.head), c("Starts", S.head), ...d.series.map((s) => c(s.label, S.headR))]];
  d.buckets.forEach((b, i) => S2.push([c(i === n - 1 && d.partialLast ? `${b.label} (${d.partialWord || "so far"})` : b.label, S.text), c(serial(b.start), S.date), ...b.values.map((v) => c(v, S.int))]));
  S2.push([c("Total", S.totText), c(null, S.totText), ...d.series.map((_, si) => fx(`SUM(${col(2 + si)}2:${col(2 + si)}${n + 1})`, S.totInt))]);

  // ---- Sites ----
  const yes = (b: boolean) => (b ? "Yes" : "");
  const S3: Cell[][] = [["Site", "Domain", "Duda status", "Created", "First published", "Unpublished", "Unpublished date", "Now", "Created in period", "Published in period", "Unpublished in period"].map((h) => c(h, S.head))];
  for (const s of d.sites) S3.push([
    c(s.name, S.text), c(s.domain, S.text), c(s.status.toLowerCase(), S.text),
    s.created ? c(serial(s.created), S.date) : c(null, S.text), s.firstPublished ? c(serial(s.firstPublished), S.date) : c(null, S.text),
    s.unpublished ? c(serial(s.unpublished), S.date) : c(null, S.text), c(s.unpublished ? (s.estimated ? "estimated (last publish)" : "seen on import") : "", S.text),
    c(s.now, S.text), c(yes(s.inCreated), S.text), c(yes(s.inPublished), S.text), c(yes(s.inUnpublished), S.text),
  ]);

  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
<Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(d.title)}</dc:title><dc:creator>${esc(CREATOR)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${d.generated.toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="By period" sheetId="2" r:id="rId2"/><sheet name="Sites" sheetId="3" r:id="rId3"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="2" hidden="1">Sites!$A$1:$K$${d.sites.length + 1}</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLES,
    "xl/worksheets/sheet1.xml": sheet(S1, { widths: [34, 22, 22, 3], heights, merges, drawing: true, gridlines: false }),
    "xl/worksheets/_rels/sheet1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    "xl/drawings/drawing1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchor(1, "rId1", [4, 0], [16, 20])}${anchor(2, "rId2", [4, 21], [12, 41])}</xdr:wsDr>`,
    "xl/drawings/_rels/drawing1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/></Relationships>`,
    "xl/charts/chart1.xml": lineChart(d),
    "xl/charts/chart2.xml": donutChart(d, first),
    "xl/worksheets/sheet2.xml": sheet(S2, { widths: [20, 16, ...d.series.map((s) => Math.max(16, s.label.length + 6))], freeze: 1 }),
    "xl/worksheets/sheet3.xml": sheet(S3, { widths: [34, 30, 14, 14, 15, 14, 22, 26, 12, 12, 13], freeze: 1, filter: `A1:K${d.sites.length + 1}` }),
  };
  return zip(files);
}
