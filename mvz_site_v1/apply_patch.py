#!/usr/bin/env python3
"""Safely build a NEW MVZ Worker file with Website API v1.
The source bot file is never overwritten.
"""
from pathlib import Path
import argparse
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly 1 anchor, found {count}. Source was not changed.')
    return text.replace(old, new, 1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('source', help='Path to current working MVZ Worker file')
    parser.add_argument('-o', '--output', default='mvz_with_site_v1.js', help='New output file; source is never overwritten')
    args = parser.parse_args()

    source = Path(args.source)
    output = Path(args.output)
    module = Path(__file__).with_name('worker_site_patch.js')
    if not source.exists():
        raise RuntimeError(f'Source not found: {source}')
    if not module.exists():
        raise RuntimeError(f'Module not found: {module}')
    if source.resolve() == output.resolve():
        raise RuntimeError('Refusing to overwrite the source file. Choose another --output path.')

    text = source.read_text(encoding='utf-8')
    site_module = module.read_text(encoding='utf-8')

    text = replace_once(
        text,
        'if (url.pathname.startsWith("/site-api/")) return await siteSupportApi(request, env, url);',
        'if (url.pathname.startsWith("/site-api/")) return await siteApiRouter(request, env, url);',
        'site-api router'
    )

    text = replace_once(
        text,
        "async function handleSupportGroupMessage(message, env) {\n  const text = (message.text || '').trim();",
        "async function handleSupportGroupMessage(message, env) {\n  if (await trySiteSupportReply(message, env)) return;\n\n  const text = (message.text || '').trim();",
        'site support reply hook'
    )

    payment_anchor = "  const endsAt = await extendUserSubscriptionDays(userId, days, env, 'paid');\n"
    payment_patch = payment_anchor + (
        "  if (String(storedPayload?.source || '').trim().toLowerCase() === 'website') {\n"
        "    await markSitePaidUserAsNonTrial(userId, env);\n"
        "  }\n"
    )
    text = replace_once(text, payment_anchor, payment_patch, 'website trial protection')

    text = replace_once(
        text,
        '\nexport default {\n',
        '\n\n' + site_module + '\n\nexport default {\n',
        'Website API module insertion'
    )

    output.write_text(text, encoding='utf-8')
    print(f'OK: created {output}')
    print('Original file was not modified.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        raise SystemExit(1)
