#!/usr/bin/env python3
"""Génère test/schema.sql (DDL PostgreSQL) à partir de prisma/schema.prisma.

Uniquement pour les tests automatisés : en développement et en production, utilise `prisma migrate`.
Les clés étrangères ne sont pas créées (les tests n'en dépendent pas). Les noms d'objets ne sont pas qualifiés :
le schéma cible est choisi à l'exécution (search_path)."""
import re, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "prisma" / "schema.prisma").read_text(encoding="utf-8")
SCALARS = {"String": "TEXT", "Int": "INTEGER", "Boolean": "BOOLEAN", "DateTime": "TIMESTAMP(3)", "Float": "DOUBLE PRECISION"}

def snake_cols(s):
    return [c.strip() for c in s.split(",") if c.strip()]

out = ["-- Généré par scripts/gen-test-sql.py, ne pas modifier à la main.\n"]
for m in re.finditer(r"^model (\w+) \{(.*?)^\}", src, re.S | re.M):
    name, body = m.group(1), m.group(2)
    cols, extras = [], []
    for raw in body.splitlines():
        line = raw.split("//")[0].strip()
        if not line:
            continue
        if line.startswith("@@unique"):
            fields = snake_cols(re.search(r"\[(.*?)\]", line).group(1))
            extras.append(f'CREATE UNIQUE INDEX "{name}_{"_".join(fields)}_key" ON "{name}"({", ".join(chr(34)+f+chr(34) for f in fields)});')
            continue
        if line.startswith("@@index"):
            fields = snake_cols(re.search(r"\[(.*?)\]", line).group(1))
            extras.append(f'CREATE INDEX "{name}_{"_".join(fields)}_idx" ON "{name}"({", ".join(chr(34)+f+chr(34) for f in fields)});')
            continue
        if line.startswith("@@"):
            continue
        fm = re.match(r"^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$", line)
        if not fm:
            continue
        fname, ftype, is_list, optional, attrs = fm.groups()
        if ftype not in SCALARS or is_list:
            continue  # relation
        sql = f'"{fname}" {SCALARS[ftype]}'
        if "@id" in attrs:
            sql += " NOT NULL PRIMARY KEY"
        else:
            if not optional:
                sql += " NOT NULL"
            d = re.search(r"@default\((.*?)\)(?:\s|$)", attrs)
            if d:
                v = d.group(1)
                if v == "now()":
                    sql += " DEFAULT CURRENT_TIMESTAMP"
                elif v.startswith('"'):
                    sql += f" DEFAULT '{v[1:-1]}'"
                elif v in ("true", "false"):
                    sql += f" DEFAULT {v}"
                elif re.fullmatch(r"-?\d+(\.\d+)?", v):
                    sql += f" DEFAULT {v}"
        cols.append(sql)
        if "@unique" in attrs:
            extras.append(f'CREATE UNIQUE INDEX "{name}_{fname}_key" ON "{name}"("{fname}");')
    out.append(f'CREATE TABLE "{name}" (\n  ' + ",\n  ".join(cols) + "\n);")
    out.extend(extras)
(root / "test" / "schema.sql").write_text("\n".join(out) + "\n", encoding="utf-8")
print("test/schema.sql généré :", src.count("\nmodel "), "modèles")
