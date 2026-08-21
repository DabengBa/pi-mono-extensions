# usage extension

Adds a `/usage` slash command that reads your local pi session files, aggregates token spend, and renders an inline dashboard with five views.

## Install

```bash
pi install npm:pi-mono-usage
```

## Views

- **Summary** — totals, top providers, and an environmental footprint estimate (kWh, kg CO₂e, real-world equivalences) computed from [`impact-equivalences`](https://www.npmjs.com/package/impact-equivalences).
- **Providers** — per-provider table that expands into per-model rows. Includes session/call counts, cost, and token breakdown (input, output, cache).
- **Patterns** — cost-driver insights for the selected period: parallel sessions, oversized contexts, large uncached prompts, marathon sessions, and top-session concentration.
- **Tools** — per-extension table that expands into per-tool rows, with call counts, estimated result tokens, and session reach.
- **Activity** — GitHub-style contribution heatmap of daily usage, plus lifetime total, peak day, current streak, and longest streak.

## Period selector

Tab between `Today`, `This Week`, `This Month`, and `All Time`. Each period is computed once on open from the same parsed dataset, so cycling is instant. The Activity view ignores the selector and always spans your full history.

## Activity heatmap

Columns are weeks (Monday-first), rows are weekdays, and the grid ends on today. It auto-sizes to as many weeks as the terminal width allows, up to a full year. Intensity uses quantile tiers over your active days, so a handful of outlier days can't wash out the rest of the grid. Press `m` to switch the metric between tokens and cost.

The color ramp is generated at runtime by sweeping the theme's `accent` color away from its background, rather than chaining semantic roles like `muted` / `dim` / `border` — those are _roles_, not a brightness scale (a theme may map `muted` to yellow), so chaining them yields hue jumps and duplicate steps. On light themes the ramp darkens as intensity rises; on dark themes it brightens. When 256-color quantization would collapse two steps onto the same index, the view falls back to density glyphs (`·░▒▓█`) so the gradient stays readable.

A streak counts consecutive days with recorded usage, and stays alive if you worked today _or_ yesterday.

## Keybindings

| Key               | Action                               |
| ----------------- | ------------------------------------ |
| `Tab` / `←` / `→` | Cycle period                         |
| `v`               | Cycle view                           |
| `1` … `5`         | Jump directly to a view              |
| `m`               | Toggle tokens / cost (Activity view) |
| `↑` / `↓`         | Move cursor (Providers, Tools views) |
| `Enter` / `Space` | Expand / collapse a row              |
| `q` / `Esc`       | Close the panel                      |

## Data source

Reads `~/.pi/agent/sessions/**/*.jsonl` (or `$PI_CODING_AGENT_DIR/sessions`) plus team-mode worker transcripts under `~/.pi/agent/extensions/team-mode/teammates/**/sessions/*.jsonl`. For each `assistant` message with a `usage` block, the extension records cost and token counts. Duplicate turns from branched session files are deduplicated by a fingerprint over timestamp + token counts.

## Sustainability estimate

The Summary view feeds the period's charged tokens (`input + output + cacheWrite`) into `impact-equivalences` `estimateAiImpact`, which returns electricity (kWh) and carbon (kg CO₂e) ranges along with formatted real-world equivalences (e.g. _"~X average US households for a day"_). Estimates are illustrative — see the package's source attribution for boundaries and assumptions.
