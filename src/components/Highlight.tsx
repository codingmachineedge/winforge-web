import { Fragment } from 'react';
import type { Range } from '../data/fuzzy';
import { mergeRanges } from '../data/fuzzy';
import '../styles/highlight.css';

interface Props {
  text: string;
  ranges: Range[];
}

/**
 * Renders `text` with the character index ranges wrapped in <mark> spans for
 * match highlighting. Ranges are merged + clamped defensively so callers can pass
 * raw fuzzyRanges() output without pre-processing. Falls back to plain text when
 * there are no ranges.
 */
export function Highlight({ text, ranges }: Props) {
  if (!ranges || ranges.length === 0) return <>{text}</>;

  const merged = mergeRanges(ranges);
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (let i = 0; i < merged.length; i++) {
    const start = Math.max(0, Math.min(merged[i]!.start, text.length));
    const end = Math.max(start, Math.min(merged[i]!.end, text.length));
    if (start > cursor) {
      parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor, start)}</Fragment>);
    }
    if (end > start) {
      parts.push(
        <mark className="hl-mark" key={`m${start}`}>
          {text.slice(start, end)}
        </mark>,
      );
    }
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor)}</Fragment>);
  }

  return <>{parts}</>;
}
