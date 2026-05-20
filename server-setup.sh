#!/bin/bash
# ============================================================
#  Wayzon — Server Bootstrap Script
#  يُستخدم مرة واحدة فقط عند إعداد السيرفر للمرة الأولى
#  متوافق مع: Ubuntu 22.04 LTS (AWS EC2 / Oracle Cloud)
# ============================================================

set -e

echo "🚀 [1/5] تحديث الحزم..."
sudo apt-get update -y
sudo apt-get upgrade -y

echo "🐳 [2/5] تثبيت Docker..."
sudo apt-get install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "👤 [3/5] إضافة المستخدم الحالي لمجموعة Docker..."
sudo usermod -aG docker $USER

echo "📂 [4/5] نسخ ملفات المشروع..."
# قم بتشغيل هذا الأمر يدوياً لنسخ مجلد backEnd من جهازك:
# scp -r f:/codeing/wayzon/backEnd ubuntu@YOUR_SERVER_IP:~/wayzon/

echo "🔓 [5/5] فتح المنافذ المطلوبة في Firewall..."
sudo ufw allow 22     # SSH
sudo ufw allow 80     # HTTP
sudo ufw allow 443    # HTTPS
sudo ufw allow 8000   # users_Payment
sudo ufw allow 3000   # Trip-Monitoring
sudo ufw allow 8001   # ML Brain
sudo ufw --force enable

echo ""
echo "✅ السيرفر جاهز! الآن ادخل لمجلد المشروع وشغّل:"
echo "   cd ~/wayzon/backEnd"
echo "   docker compose up -d --build"
