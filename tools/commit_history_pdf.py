#!/usr/bin/env python3
"""Render the full git commit log to a plain, readable PDF.

Usage: python tools/commit_history_pdf.py <output.pdf> [repo_dir]
Reads `git log` (newest first) with: short SHA | date | author | subject.
"""
import subprocess
import sys
import os


def get_log(repo_dir: str) -> list[tuple[str, str, str, str]]:
    fmt = "%h\x1f%ad\x1f%an\x1f%s"
    out = subprocess.run(
        ["git", "-C", repo_dir, "log", f"--pretty=format:{fmt}", "--date=short"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    rows = []
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\x1f")
        while len(parts) < 4:
            parts.append("")
        rows.append((parts[0], parts[1], parts[2], parts[3]))
    return rows


def build_pdf(path: str, rows: list[tuple[str, str, str, str]], repo_name: str) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    styles = getSampleStyleSheet()
    title_style = styles["Title"]
    meta_style = ParagraphStyle("meta", parent=styles["Normal"], fontSize=8, textColor=colors.grey)
    cell = ParagraphStyle("cell", parent=styles["Normal"], fontSize=7.5, leading=9.5,
                          fontName="Helvetica")
    cell_mono = ParagraphStyle("mono", parent=cell, fontName="Courier")

    doc = SimpleDocTemplate(
        path, pagesize=A4,
        leftMargin=14 * mm, rightMargin=14 * mm, topMargin=16 * mm, bottomMargin=14 * mm,
        title=f"{repo_name} — commit history",
    )

    story = [
        Paragraph(f"{repo_name} — commit history", title_style),
        Paragraph(f"{len(rows)} commits · newest first · auto-generated on each commit", meta_style),
        Spacer(1, 6 * mm),
    ]

    header = ["SHA", "Date", "Author", "Summary"]
    data = [header]
    for sha, date, author, subject in rows:
        data.append([
            Paragraph(sha, cell_mono),
            Paragraph(date, cell),
            Paragraph(author, cell),
            Paragraph((subject or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), cell),
        ])

    col_widths = [16 * mm, 20 * mm, 34 * mm, 112 * mm]
    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1b1b1f")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f3f5")]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d8d8de")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(table)
    doc.build(story)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: commit_history_pdf.py <output.pdf> [repo_dir]", file=sys.stderr)
        return 2
    out = sys.argv[1]
    repo_dir = sys.argv[2] if len(sys.argv) > 2 else "."
    repo_name = os.path.basename(os.path.abspath(repo_dir)) or "repo"
    rows = get_log(repo_dir)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    build_pdf(out, rows, repo_name)
    print(f"wrote {out} ({len(rows)} commits)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
