#!/usr/bin/env python3
"""
Data-loading step for the content-engine schema (migration
20260710000000_content_engine_schema.sql).

Loads /Users/petermckenzie/CODE/firststab/compliance/ventura-county-compliance-kb.json
into the compliance_kb_meta, compliance_topics, and compliance_claims tables.

Run this AFTER the migration has been applied to the live Supabase project.
Safe to re-run: it checks for an existing kb_meta row for the same source
file/title and will skip re-inserting if already loaded, unless --force is passed.

Usage:
    python3 load_compliance_claims.py            # normal run
    python3 load_compliance_claims.py --force     # wipe and reload

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the project .env
(service role key is required because RLS is enabled with no permissive
policies yet — only the service role can write to these tables right now).
"""

import os
import sys
import json
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

PROJECT_ROOT = Path("/Users/petermckenzie/CODE/firststab")
KB_PATH = PROJECT_ROOT / "compliance" / "ventura-county-compliance-kb.json"
ENV_PATH = PROJECT_ROOT / ".env"


def main():
    force = "--force" in sys.argv

    load_dotenv(ENV_PATH)
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    client = create_client(url, key)

    with open(KB_PATH) as f:
        data = json.load(f)

    meta = data["_meta"]
    topics = data["topics"]

    total_claims_in_file = sum(len(claims) for claims in topics.values())
    print(f"Source file claims: {total_claims_in_file} (meta says total_claims={meta.get('total_claims')})")

    # ---- idempotency check ----
    existing = client.table("compliance_kb_meta").select("id").eq("source_file", str(KB_PATH)).execute()
    if existing.data and not force:
        print(f"compliance_kb_meta already has a row for this source file "
              f"(id={existing.data[0]['id']}). Skipping load. Use --force to reload.")
        return
    if existing.data and force:
        kb_id = existing.data[0]["id"]
        print(f"--force passed: deleting existing kb_meta row {kb_id} and its topics/claims first.")
        old_topics = client.table("compliance_topics").select("id").eq("kb_meta_id", kb_id).execute()
        old_topic_ids = [t["id"] for t in old_topics.data]
        if old_topic_ids:
            client.table("compliance_claims").delete().in_("topic_id", old_topic_ids).execute()
            client.table("compliance_topics").delete().eq("kb_meta_id", kb_id).execute()
        client.table("compliance_kb_meta").delete().eq("id", kb_id).execute()

    # ---- insert kb_meta ----
    kb_meta_row = {
        "title": meta.get("title"),
        "prepared_for": meta.get("prepared_for"),
        "prepared_by": meta.get("prepared_by"),
        "geography_covered": meta.get("geography_covered"),
        "date_generated": meta.get("date_generated"),
        "next_review_owner": meta.get("next_review_owner"),
        "freshness_warning": meta.get("freshness_warning"),
        "methodology_note": meta.get("methodology_note"),
        "total_claims": meta.get("total_claims"),
        "claims_needing_human_review": meta.get("claims_needing_human_review"),
        "review_log": meta.get("review_log"),
        "known_local_ordinances": meta.get("known_local_ordinances_beyond_state_law"),
        "source_file": str(KB_PATH),
    }
    kb_res = client.table("compliance_kb_meta").insert(kb_meta_row).execute()
    kb_meta_id = kb_res.data[0]["id"]
    print(f"Inserted compliance_kb_meta row: {kb_meta_id}")

    # ---- insert topics + claims ----
    total_inserted = 0
    for topic_key, claims in topics.items():
        topic_res = client.table("compliance_topics").insert({
            "topic_key": topic_key,
            "kb_meta_id": kb_meta_id,
        }).execute()
        topic_id = topic_res.data[0]["id"]

        claim_rows = []
        for c in claims:
            claim_rows.append({
                "claim_key": c["id"],
                "topic_id": topic_id,
                "statement": c["statement"],
                "jurisdiction_scope": c["jurisdiction_scope"],
                "confidence": c["confidence"],
                "status": c["status"],
                "evidence": c["evidence"],
                "conflicts": c.get("conflicts"),
                "notes": c.get("notes"),
                "resolution_log": c.get("resolution_log"),
                "downstream_review_required": c.get("downstream_review_required"),
            })

        if claim_rows:
            client.table("compliance_claims").insert(claim_rows).execute()
            total_inserted += len(claim_rows)
        print(f"  topic '{topic_key}': inserted {len(claim_rows)} claims")

    print(f"\nTotal claims inserted: {total_inserted}")

    # ---- verify row count ----
    count_res = client.table("compliance_claims").select("id", count="exact").execute()
    print(f"compliance_claims row count in DB: {count_res.count}")
    if count_res.count == 55:
        print("MATCH: 55 claims confirmed in database.")
    else:
        print(f"MISMATCH: expected 55, found {count_res.count}. Investigate before proceeding.")


if __name__ == "__main__":
    main()
