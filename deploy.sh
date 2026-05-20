#!/bin/bash
# ============================================================
#  Wayzon — Deploy / Update Script
#  استخدم هذا السكريبت في كل مرة تريد تحديث السيرفر
# ============================================================

set -e

echo "📥 [1/3] سحب آخر تحديثات من GitHub..."
git pull origin main

echo "🏗️  [2/3] بناء وتشغيل الحاويات..."
docker compose up -d --build --remove-orphans

echo "🧹 [3/3] تنظيف الصور القديمة..."
docker image prune -f

echo ""
echo "✅ تم النشر بنجاح! حالة الخدمات:"
docker compose ps
