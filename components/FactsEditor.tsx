"use client";
import { useState } from "react";
import { DAYS, DAY_LABEL, type Facts, type Day } from "@/lib/facts";

export function Chips({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [t, setT] = useState("");
  const add = () => {
    const parts = t.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setT("");
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      {!!value.length && (
        <div className="chips">
          {value.map((v, i) => <span key={i} className="chip">{v}<button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button></span>)}
        </div>
      )}
      <input value={t} placeholder={placeholder || "Type and press Enter (comma-separate for many)"} onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} onBlur={add} />
    </div>
  );
}

export default function FactsEditor({ facts, onChange }: { facts: Facts; onChange: (f: Facts) => void }) {
  const set = <K extends keyof Facts>(k: K, v: Facts[K]) => onChange({ ...facts, [k]: v });
  const hours = new Map(facts.hours.map((h) => [h.day, h.value]));
  const setHour = (d: Day, v: string) => {
    const m = new Map(hours); if (v.trim()) m.set(d, v); else m.delete(d);
    set("hours", DAYS.filter((x) => m.has(x)).map((x) => ({ day: x, value: m.get(x)! })));
  };

  return (
    <div className="stack">
      <div className="grid2">
        <label className="field"><span>Business name (exact spelling)</span><input value={facts.businessName} onChange={(e) => set("businessName", e.target.value)} /></label>
        <label className="field"><span>Website domain</span><input value={facts.websiteDomain} onChange={(e) => set("websiteDomain", e.target.value)} placeholder="joesauto.com" /></label>
      </div>
      <label className="field"><span>Accepted name variants</span><Chips value={facts.altNames} onChange={(v) => set("altNames", v)} placeholder="e.g. Joe's Auto" /></label>
      <div className="grid2">
        <label className="field"><span>Phone numbers</span><Chips value={facts.phones} onChange={(v) => set("phones", v)} placeholder="(555) 123-4567" /></label>
        <label className="field"><span>Emails</span><Chips value={facts.emails} onChange={(v) => set("emails", v)} /></label>
      </div>

      <div className="field"><span className="small muted" style={{ fontWeight: 600, textTransform: "uppercase" }}>Locations</span>
        {facts.locations.map((l, i) => (
          <div key={i} className="row" style={{ flexWrap: "nowrap", marginTop: 6 }}>
            <input style={{ flex: 3 }} placeholder="Street" value={l.street} onChange={(e) => set("locations", facts.locations.map((x, j) => j === i ? { ...x, street: e.target.value } : x))} />
            <input style={{ flex: 2 }} placeholder="City" value={l.city} onChange={(e) => set("locations", facts.locations.map((x, j) => j === i ? { ...x, city: e.target.value } : x))} />
            <input style={{ width: 60 }} placeholder="ST" maxLength={2} value={l.state} onChange={(e) => set("locations", facts.locations.map((x, j) => j === i ? { ...x, state: e.target.value.toUpperCase() } : x))} />
            <input style={{ width: 90 }} placeholder="ZIP" value={l.zip} onChange={(e) => set("locations", facts.locations.map((x, j) => j === i ? { ...x, zip: e.target.value } : x))} />
            <button type="button" className="ghost" onClick={() => set("locations", facts.locations.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <div><button type="button" className="sm" style={{ marginTop: 6 }} onClick={() => set("locations", [...facts.locations, { street: "", city: "", state: "", zip: "" }])}>+ Location</button></div>
      </div>

      <div className="field"><span className="small muted" style={{ fontWeight: 600, textTransform: "uppercase" }}>Hours (leave blank if unknown)</span>
        <div className="grid2" style={{ marginTop: 6 }}>
          {DAYS.map((d) => (
            <div key={d} className="row" style={{ flexWrap: "nowrap" }}>
              <span style={{ width: 90 }} className="small">{DAY_LABEL[d]}</span>
              <input value={hours.get(d) || ""} placeholder="8:00 AM - 5:00 PM / Closed" onChange={(e) => setHour(d, e.target.value)} />
            </div>
          ))}
        </div>
      </div>

      <div className="field"><span className="small muted" style={{ fontWeight: 600, textTransform: "uppercase" }}>Social / review links</span>
        {facts.socials.map((s, i) => (
          <div key={i} className="row" style={{ flexWrap: "nowrap", marginTop: 6 }}>
            <select style={{ width: 140 }} value={s.platform} onChange={(e) => set("socials", facts.socials.map((x, j) => j === i ? { ...x, platform: e.target.value } : x))}>
              {["facebook", "instagram", "google", "yelp", "x", "linkedin", "youtube", "tiktok"].map((p) => <option key={p}>{p}</option>)}
            </select>
            <input value={s.url} placeholder="https://…" onChange={(e) => set("socials", facts.socials.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
            <button type="button" className="ghost" onClick={() => set("socials", facts.socials.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <div><button type="button" className="sm" style={{ marginTop: 6 }} onClick={() => set("socials", [...facts.socials, { platform: "facebook", url: "" }])}>+ Link</button></div>
      </div>

      <div className="grid2">
        <label className="field"><span>Services offered</span><Chips value={facts.services} onChange={(v) => set("services", v)} /></label>
        <label className="field"><span>Cities served</span><Chips value={facts.citiesServed} onChange={(v) => set("citiesServed", v)} /></label>
      </div>

      <div className="field"><span className="small muted" style={{ fontWeight: 600, textTransform: "uppercase" }}>Other facts (year established, warranty, certifications…)</span>
        {facts.custom.map((c, i) => (
          <div key={i} className="row" style={{ flexWrap: "nowrap", marginTop: 6 }}>
            <input style={{ flex: 1 }} value={c.key} placeholder="Label" onChange={(e) => set("custom", facts.custom.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
            <input style={{ flex: 2 }} value={c.value} placeholder="Value" onChange={(e) => set("custom", facts.custom.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
            <button type="button" className="ghost" onClick={() => set("custom", facts.custom.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <div><button type="button" className="sm" style={{ marginTop: 6 }} onClick={() => set("custom", [...facts.custom, { key: "", value: "" }])}>+ Fact</button></div>
      </div>
      <label className="field"><span>Notes for the AI reviewer</span><textarea value={facts.notes} onChange={(e) => set("notes", e.target.value)} placeholder="e.g. Client prefers 'auto repair' not 'car repair'. Don't mention towing." /></label>
    </div>
  );
}
