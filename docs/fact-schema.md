# Shared Fact Schema

All three agents read and write one fact store. This schema is the contract between them.

## Rules

- The School Agent outranks everyone. If group chatter conflicts with a school fact, the school fact wins.
- Every fact carries provenance: what document it came from, and when it was published.
- Family-specific information never becomes a shared fact. Order status, calendar details, and anything about one family live in the Parent Agent only. The shared layer only ever carries aggregates (e.g. "18 of 22 ordered").

## Fact fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable unique id for the fact |
| `type` | enum | `deadline`, `event`, `requirement`, `change`, `announcement` |
| `title` | string | Short human-readable title, e.g. "Pizza order deadline" |
| `detail` | string | The full fact in plain language, e.g. "$3/slice, form linked below" |
| `date` | string (ISO date) | The date the deadline/event falls on, if any |
| `time` | string | Optional, if the source states one |
| `applies_to` | string | Who this applies to, e.g. "all grades", "Grade 2", "U9 parents" |
| `action_required` | boolean | Does a parent need to do something? |
| `action` | string | What to do, e.g. "Submit pizza order form" |
| `link` | string (URL) | Form / source link, if any |
| `source_document` | string | What it came from, e.g. "SJA newsletter, Oct 26, 2026" |
| `source_text` | string | The exact passage the fact was extracted from |
| `published_at` | string (ISO datetime) | When the source was published |
| `extracted_at` | string (ISO datetime) | When the School Agent created this fact |
| `confidence` | number (0–1) | Extraction confidence; low-confidence facts get flagged, not published silently |
| `supersedes` | string | Optional: id of an earlier fact this one replaces (for changes/corrections) |

## Example fact (the demo slice)

```json
{
  "id": "fact-pizza-deadline-2026-10-30",
  "type": "deadline",
  "title": "Pizza order deadline",
  "detail": "$3/slice. Order form must be submitted by Friday.",
  "date": "2026-10-30",
  "applies_to": "all grades",
  "action_required": true,
  "action": "Submit pizza order form",
  "link": "",
  "source_document": "SJA newsletter",
  "source_text": "Pizza orders are due Friday. $3 per slice.",
  "published_at": "",
  "extracted_at": "",
  "confidence": 1.0,
  "supersedes": ""
}
```

## Open questions to decide during the build

- Store format: JSON file first (demo), SQLite if querying gets painful.
- How a correction is represented: new fact with `supersedes`, never an edit in place — the event log should show the change.
- Aggregate facts: separate type, or a flag on the Group Agent side only?
