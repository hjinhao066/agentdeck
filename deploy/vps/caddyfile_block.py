#!/usr/bin/env python3
"""Edit exactly one site block of a Caddyfile, byte-for-byte leaving everything else alone.

  replace  --caddyfile F --address A --new SNIPPET --out OUT --old-out OLD
           Put the BEGIN/END region of SNIPPET in place of the managed region (BEGIN/END markers) or,
           on first install, of the single site block whose address is A. The replaced text goes to OLD.
  restore  --caddyfile F --old OLD --out OUT
           Put OLD back in place of the managed region (empty OLD removes it).
  auth     --caddyfile F --address A --out AUTH
           Copy the basicauth directive of site A into AUTH as a site-wide `basicauth { ... }`.
           Credentials are never printed.

Refuses (exit 2) instead of guessing: address missing/duplicated/combined with other addresses,
unbalanced braces, more than one managed region, basicauth with a matcher or unknown arguments.
"""
import argparse
import re
import sys

BEGIN = "# BEGIN agentdeck-three-ends"
END = "# END agentdeck-three-ends"


class Refuse(Exception):
    pass


def line_depths(lines):
    """Brace depth at the start of each line, ignoring comments and quoted/backtick strings."""
    depths, depth, quote = [], 0, None
    for line in lines:
        depths.append(depth)  # depth before this line; the final entry below is the depth after the last line
        i, prev_space = 0, True
        while i < len(line):
            ch = line[i]
            if quote:
                if ch == "\\" and quote == '"':
                    i += 1
                elif ch == quote:
                    quote = None
            elif ch in ('"', "`"):
                quote = ch
            elif ch == "#" and prev_space:
                break
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            prev_space = ch in " \t"
            i += 1
        if depth < 0:
            raise Refuse("unbalanced braces in Caddyfile")
    if depth != 0 or quote:
        raise Refuse("unbalanced braces or quotes in Caddyfile")
    depths.append(0)
    return depths


def block_end(lines, depths, start):
    for i in range(start, len(lines)):
        if depths[i + 1] == 0:
            return i
    raise Refuse("site block is not closed")


def managed_region(lines):
    begins = [i for i, l in enumerate(lines) if l.rstrip("\r\n") == BEGIN or l.startswith(BEGIN + " ")]
    ends = [i for i, l in enumerate(lines) if l.rstrip("\r\n") == END]
    if not begins and not ends:
        return None
    if len(begins) != 1 or len(ends) != 1 or ends[0] < begins[0]:
        raise Refuse("expected exactly one BEGIN/END agentdeck-three-ends marker pair")
    return begins[0], ends[0]


def find_site(lines, address):
    depths = line_depths(lines)
    exact = re.compile(r"^\s*(?:https?://)?" + re.escape(address) + r"(?::\d+)?\s*\{\s*(?:#.*)?$")
    mentions = [i for i, l in enumerate(lines)
                if depths[i] == 0 and address in l and re.search(r"\{\s*(?:#.*)?$", l) and not l.lstrip().startswith("#")]
    exacts = [i for i in mentions if exact.match(lines[i].rstrip("\r\n"))]
    if len(mentions) != len(exacts) or len(exacts) > 1:
        raise Refuse(f"address {address} appears in {len(mentions)} site line(s), {len(exacts)} of them a plain single-address block; "
                     "edit the Caddyfile by hand")
    if not exacts:
        return None
    return exacts[0], block_end(lines, depths, exacts[0])


def read_lines(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read().splitlines(keepends=True)


def snippet_region(path):
    lines = read_lines(path)
    region = managed_region(lines)
    if not region:
        raise Refuse("snippet has no BEGIN/END markers")
    return lines[region[0]:region[1] + 1]


def ensure_newline(lines):
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    return lines


def cmd_replace(a):
    lines = read_lines(a.caddyfile)
    new = ensure_newline(snippet_region(a.new))
    region = managed_region(lines)
    if region:
        start, end = region
        site = find_site(lines[start:end + 1], a.address)
        if site is None:
            raise Refuse("managed region exists but contains no site block for the address")
    else:
        site = find_site(lines, a.address)
        start, end = (site if site else (None, None))
    if start is None:
        old, out = [], ensure_newline(list(lines)) + (["\n"] if lines else []) + new
    else:
        old = lines[start:end + 1]
        out = lines[:start] + new + lines[end + 1:]
    write(a.old_out, "".join(old))
    write(a.out, "".join(out))
    print("replaced existing block" if old else "appended new block")


def cmd_restore(a):
    lines = read_lines(a.caddyfile)
    region = managed_region(lines)
    if not region:
        raise Refuse("no managed region in the Caddyfile; nothing to roll back")
    start, end = region
    old = ensure_newline(read_lines(a.old))
    if old:
        out = lines[:start] + old + lines[end + 1:]
    else:
        out = lines[:start] + lines[end + 1:]
        if start > 0 and out[start - 1].strip() == "" and (start == len(out) or out[start].strip() == ""):
            del out[start - 1]
    write(a.out, "".join(out))
    print("restored previous block" if old else "removed managed block")


def cmd_auth(a):
    lines = read_lines(a.caddyfile)
    region = managed_region(lines)
    # Prefer an already-managed block's directive (it imports the auth file, so use the old backup there).
    site = find_site(lines, a.address) if not region else None
    if site is None:
        raise Refuse("no plain site block for the address (is it already managed?)")
    start, end = site
    depths = line_depths(lines)
    found = []
    for i in range(start + 1, end):
        if depths[i] == 1:
            m = re.match(r"^\s*(basicauth|basic_auth)\b(.*?)\{\s*(?:#.*)?$", lines[i].rstrip("\r\n"))
            if m:
                found.append((i, m.group(2).split()))
    if len(found) != 1:
        raise Refuse(f"expected exactly one basicauth directive in the existing block, found {len(found)}")
    i, args = found[0]
    if args not in ([], ["*"], ["bcrypt"], ["*", "bcrypt"]):
        raise Refuse("basicauth has a path matcher or custom arguments; create the auth file by hand")
    entries = []
    j = i + 1
    while j < len(lines) and depths[j] >= 2:
        text = lines[j].strip()
        if text == "}":
            break
        if text and not text.startswith("#"):
            if len(text.split()) != 2:
                raise Refuse("unexpected line inside basicauth block")
            entries.append(text)
        j += 1
    if not entries:
        raise Refuse("basicauth block has no entries")
    write(a.out, "basicauth {\n" + "".join(f"\t{e}\n" for e in entries) + "}\n")
    print(f"extracted {len(entries)} basicauth entr{'y' if len(entries) == 1 else 'ies'} (not shown)")


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("replace"); r.set_defaults(fn=cmd_replace)
    for n in ("caddyfile", "address", "new", "out", "old-out"):
        r.add_argument("--" + n, required=True)
    s = sub.add_parser("restore"); s.set_defaults(fn=cmd_restore)
    for n in ("caddyfile", "old", "out"):
        s.add_argument("--" + n, required=True)
    u = sub.add_parser("auth"); u.set_defaults(fn=cmd_auth)
    for n in ("caddyfile", "address", "out"):
        u.add_argument("--" + n, required=True)
    a = p.parse_args()
    a.old_out = getattr(a, "old_out", None)
    try:
        a.fn(a)
    except Refuse as e:
        print(f"refused: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
