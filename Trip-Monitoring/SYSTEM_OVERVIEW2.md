# نظام تتبع وأمان الرحلات - دليل شامل (B2B & B2C Platform)

> [!IMPORTANT]
> هذا النظام مصمم ليكون منصة تقنية متكاملة تخدم قطاعي الأعمال (**B2B**) والأفراد (**B2C**)، مع توفير حلول أمان وتتبع مخصصة تلبي احتياجات الشركات السياحية والمستخدمين الأفراد على حد سواء.

## 📋 نظرة عامة

نظام متكامل لمراقبة الرحلات السياحية في الوقت الفعلي باستخدام **15 طبقة أمان** متطورة، تعتمد على **الذكاء الزمني (Temporal)**، **الذكاء المكاني (Spatial)**، و**أوركسترا اتخاذ القرار (Decision Orchestration)**، مع دمج **ML Decision Engine** وتحليل ذكي متعدد المستويات وتتبع المسار وتخصيص تجربة المستخدم (Personalization).

---

## 🌍 Global Geo-Aware & Language Architecture 🆕

**"نظام يفهم العالم، ويتحدث الإنجليزية"**

تم إعادة تصميم النظام ليكون **Geo-Aware** بالكامل، مما يعني أنه يغير سلوكه الداخلي بناءً على موقع المستخدم وحالته، لكنه يحافظ على واجهة موحدة.

### 1. English-Only User Interface (Strict Policy)

- **القاعدة:** جميع الرسائل الموجهة للمستخدم (Notifications, Questions, Alerts, System Messages) تكون **باللغة الإنجليزية حصراً**.
- **الهدف:** توحيد لغة التواصل عالمياً وتجنب أخطاء الترجمة اللحظية في المواقف الحرجة.

### 2. Non-Intervention Guarantee (سياسة عدم التدخل التلقائي)

> [!IMPORTANT]
> يطبق النظام سياسة **"Advisory-Only"**. لا يقوم النظام أبداً بإلغاء رحلة، أو تغيير مسارها، أو تعديل حالتها تلقائياً.
>
> - **الدور:** مراقب ومستشار (Monitor & Advisor).
> - **الفعل:** يرسل تحذيرات للمستخدم وتنبيهات للأدمن.
> - **المسؤولية:** يتم توثيق كافة التحذيرات في سجل التدقيق (Audit Trail) لإبراء الذمة القانونية، ولكن القرار النهائي يبقى دائماً بيد المستخدم.

- **التطبيق:** تم استبدال كافة القوالب العربية في `flexibleResponseService`, `routeMonitor`, `safetyOrchestrator` بنصوص إنجليزية معتمدة.

### 2. Localized Internal Intelligence (GeoConfig)

بينما الواجهة إنجليزية، فإن "عقل" النظام يعمل بذكاء محلي لضمان الأمان:

- **GeoConfig.js:** ملف تكوين مركزي يدير إعدادات 50+ دولة و 11 لغة.
- **Search Engine Adaptation:**
  - في **الصين**: يستخدم Baidu.
  - في **روسيا**: يستخدم Yandex.
  - عالمياً: Google/Bing/DuckDuckGo.
- **Danger Detection:** يستخدم كلمات مفتاحية **بلغة البلد المحلية** (مثل "مباشر" بالعربية، "пожар" بالروسية) للكشف عن المخاطر في الأخبار والفيديو، لأن المحتوى المحلي يظهر أسرع بلغته الأم.

### 3. Smart Resource Allocation

- **Always-on Scanning:** في الدول عالية الخطورة (مثل سوريا، اليمن، العراق)، يتم تفعيل مسح الفيديو لحظياً بصرف النظر عن التكلفة.
- **Bounding Boxes:** استخدام صناديق جغرافية دقيقة لتحديد الدولة وتطبيق قوانينها (مثل الحظر الليلي وسرعة الطرق) حتى بدون API خارجي.

### 4. Adaptive Notification Intensity (Guide vs Tourist) 🆕

- **Different Rules:** النظام يفصل بين "المرشد" و"السائح" في منطق الإشعارات.
- **Silent Guide:** إذا كان المرشد موثوقاً وطلب "رسائل أقل" (Very Low Intensity)، يتم كتم التنبيهات العادية (Low/Medium Risk) وإرسال **المخاطر القصوى فقط (Critical/Danger)**.
- **Parallel Streams:** يتم حساب قرار التنبيه لكل مستخدم على حدة في نفس اللحظة لضمان راحة المرشد وأمان السائح.

---

## 🚀 كيف يبدأ النظام؟

### 1. تشغيل السيرفر (`bin/www`)

```bash
npm start
```

**ما يحدث:**

1. يقرأ `app.js`
2. يتصل بـ MongoDB (3 قواعد بيانات)
3. يتصل بـ Redis
5. **يستدعي `initServices()`** ← هنا يبدأ نظام الرحلات

### 2. تهيئة الخدمات (`services/initServices.js`)

```javascript
const { initializeServices } = require("./services/initServices");
await initializeServices();
```

**يشغل:**

- `mlBrain.init()` ← الاتصال بـ **Python ML Service** (Port 8001) والتحقق من حالته.
- `tripScheduler.start()` ← جدولة الرحلات

---

## 🗺️ نظام طلب الرحلات والمزايدة (Bidding & Ordering)

**الملف:** `controllers/order.controllers.js`, `controllers/order.guide.controllers.js`

### 1. أنواع الرحلات (Trip Types)

- **`with_guide`**: رحلة تحتاج لمرشد سياحي.
- **`solo_system`**: رحلة فردية (Solo) تعتمد على تتبع الأمان التلقائي فقط.
  - **ML Awareness**: النظام يدرك غياب المرشد ويقوم بتعطيل ميزات "تباعد المرشد" وتقييماته تلقائياً لتجنب الانحياز في تحليل البيانات.
  - **System Feedback**: التقييم يوجه تلقائياً للنظام ("كيف كانت تجربتك مع المراقبة؟") بدلاً من مستخدم آخر.

### 2. حالة الوجهة (Destination Status)

- **`defined`**: السائح يحدد الأماكن مسبقاً.
- **`undefined`**: السائح يحدد مدينة أو فكرة عامة ويطلب من المرشدين اقتراح "خط سير" (Itinerary).

### 3. تدفق المزايدة (Bidding Flow)

1. السائح ينشئ طلب (`bidding` لو الوجهة غير محددة).
2. المرشدين يقدمون عروض (`offers`) تشمل:
   - السعر المقترح (`proposedPrice`).
   - خط السير المقترح (`proposedItinerary`) - اختياري.
   - وصف العرض.
3. السائح يستعرض العروض ويختار الأنسب (`selectOffer`).
   - **الترتيب والتصفية**: يمكن للسائح ترتيب المتقدمين حسب (الأقل سعراً، الأكثر خبرة، أو القبول الفوري).
   - **توزيع عادل**: قائمة المرشدين تظهر بشكل عشوائي (Randomized) لضمان عدم التحيز.
4. يتم تحديث بيانات الطلب تلقائياً وتتحول الحالة لـ `confirmed`.

### 4. البحث المتقدم للمرشدين (Guide Filters)

يمكن للمرشدين تصفية الطلبات المتاحة باستخدام المعامل `filter`:

- **`no_itinerary`**: الطلبات التي لا تحتوي على خط سير محدد.
- **`bidding`**: الطلبات المفتوحة للمزايدة فقط.
- **`ready`**: الرحلات ذات الوجهات المحددة مسبقاً والجاهزة للبدء.

### 5. إدارة تداخل المواعيد (Conflict Management)

**الملف:** `util/tripUtils.js`

- **التدفق**: بمجرد تأكيد مرشد في رحلة، يقوم النظام بـ:
  - **سحب تلقائي (`withdrawConflicts`)**: سحب كل طلبات المرشد في رحلات تانية تتعارض في الوقت.
  - **إعادة تلقائية (`restoreConflicts`)**: إذا ألغيت الرحلة المؤكدة، يعيد النظام طلبات المرشد المسحوبة للرحلات التي لا تزال مفتوحة.
  - **منع التزييف**: يمنع المرشد من التقديم على رحلات في أوقات محجوزة عنده.

### 6. مستويات خطط الأمان (Safety Plan Tiers)

#### **الخطة المجانية - "المراقب الصامت" (Silent Guardian):**

- **التكلفة**: مجانية تماماً ($0).
- **الهدف**: توفير أمان أساسي مع الحفاظ على خصوصية المستخدم وتقليل استهلاك الموارد.
- **الميزات**:
  - **تتبع ذكي مجدول**: يتم إجراء تحليل عميق للموقع كل 5 دقائق لتقليل استهلاك البطارية ومصاريف الـ AI.
  - **تنبيهات Geofence**: تنبيه واحد فقط في حال الخروج عن مدينة الرحلة أو المسار العام.
  - **نظام "أنا تمام" (Manual Check-in)**: يمكن للسائح إرسال إشارة أمان يدوية لإلغاء أي تحذيرات بسيطة.
  - **خصوصية عالية**: لا توجد أسئلة ذكاء اصطناعي إجبارية أو متابعة مستمرة إلا في حالات الطوارئ القصوى.
  - **التعلم المستمر**: النظام "يراقب بصمت" للتعلم وتحسين نموذج الـ ML دون تدخل مباشر.

#### **الخطة المتقدمة - "المراقبة الذكية" (Elite Monitoring):**

- **التكلفة**: **$8** للرحلة.
- **الهدف**: حماية استباقية كاملة باستخدام قوّة الذكاء الاصطناعي القصوى.
- **الميزات**:
  - **مراقبة لحظية (Real-time)**: تحليل سلوكي مستمر لكل حركة بدون فواصل زمنية.
  - **ذكاء اصطناعي استباقي (Proactive AI)**: النظام يسأل السائح آلياً في حال اشتباه (مثل الوقوف الطويل أو الانحراف) للتأكد من سلامته.
  - **تصعيد ذكي (Escalation)**: في حال عدم الرد، يتم التصعيد الفوري لمركز العمليات أو الطوارئ.
  - **تحليل كامل لـ 12 طبقة أمان**: تشمل تباعد المرشد، سرعة المركبة، سمعة المنطقة، وتوافق المسار.

### 7. تحليل السرعة الديناميكي (Dynamic Speed Analysis)

**الملف:** `services/safety/speedAnalyzer.js`

- **على اليابسة (Land)**: يقوم النظام بجلب قوانين السرعة للدولة (Highway/City) آلياً وتطبيقها باستخدام الذكاء الاصطناعي.
- **في الجو والبحر (Air & Sea)**: يتعرف النظام تلقائياً على "طيارة" أو "سفينة" ويطبق معايير أمان خاصة (Cruise Speeds) بدلاً من قوانين الطرق البرية.
- **التصرف**: يتم تحذير المستخدم عند تجاوز الحد المسموح بنسبة 10%، والتصعيد للأدمن عند تجاوز قدرة المركبة الحقيقية.

### 8. استراتيجية "القيمة أولاً" (Value-First Search & Reputation) 🔄

**الملف:** `locationReputationService.js`, `searchEngineAggregator.js`, `videoRiskAnalyzer.js`

يعتمد النظام "سلم تصعيد البحث" (Search Escalation Ladder) لتقليل التكاليف دون المساس بالأمان:

1.  **المستوى 1 (Internal First):** البحث في قاعدة بيانات ML Brain والنتائج المخزنة (Cache).
2.  **المستوى 2 (Global Free Strategy):** استخدام **OpenStreetMap (OSM)** للخرائط و **DuckDuckGo** للبحث بشكل أساسي عالمياً. يتم "استنزاف" (Drain) المصادر المجانية أولاً قبل اللجوء للمدفوع.
3.  **المستوى 3 (Lazy Video Scan):** لا يتم تفعيل مسح الفيديو (المكلف) إلا إذا كانت نتائج النصوص تشير لخطر أو غير كافية. يتم التحقق من **صحة الإحداثيات** (Coordinate Validation) قبل البدء لمنع هدر الموارد على بيانات خاطئة أو (0,0).
4.  **المستوى 4 (Deep Analysis):** استخدام Gemini AI فقط في البيئات غير المؤكدة أو عالية الخطورة.

**المميزات التشغيلية:**

- **تخفيض الكاش (Gridded Caching):** تخزين نتائج الخرائط في "شبكات" (Grids) بمساحة ~550 متر لزيادة معدل الـ Cache Hit.
- **تخصيص المحركات:** استخدام **Yandex** في روسيا/CIS و **Baidu** في الصين لتقليل الاعتماد على Google Maps المكلف في تلك المناطق.
- **إدارة الموارد (Connection Pooling):** جميع طلبات الخرائط (Google, OSM, Baidu, Yandex, HERE) تتم عبر **متحدث رسمي موحد (Pooled Agents)** للحفاظ على استقرار السيرفر ومنع استنزاف موارد الشبكة تحت الضغط العالي.

### 9. نظام الإشعارات المستديم (Persistent Notification Queue) 🆕

**الملف:** `services/notificationQueueService.js`

بدلاً من الاعتماد على الذاكرة المؤقتة، يعتمد السيرفر نظام طوابير مرن يضمن وصول التنبيهات حتى بعد إعادة تشغيل النظام:

1.  **الاستدامة (Redis-Backed):** يتم تخزين كافة التنبيهات في **Redis List**. هذا يمنع فقدان "رسائل الطوارئ" والتحذيرات الحرجة.
2.  **ذكاء إعادة المحاولة (Retry with Backoff):** في حال فشل الإرسال (مشكلة في شبكة السائح أو سيرفرات FCM)، يقوم النظام بإعادة المحاولة تلقائياً بفواصل زمنية متزايدة (Exponential Backoff).
3.  **طابور الرسائل الميتة (Dead Letter Queue - DLQ):** الرسائل التي تفشل في الوصول بعد استنفاد المحاولات (Max Retries) يتم نقلها لطابور خاص للتحليل من قبل الأدمن، لضمان عدم ضياع أي أثر قانوني.
4.  **منع التكرار (Deduplication):** يستخدم النظام Redis لمنع إرسال نفس التحذير مرتين في وقت قصير، للحفاظ على هدوء المستخدم وتركيزه.
5.  **ساعات الهدوء (Quiet Hours):** النظام يحترم التوقيت المحلي للمستخدم؛ الرسائل غير الحرجة تُؤجل، بينما تخترق رسائل الطوارئ أي قيود.

---

## 📍 تحديث الموقع - Location Updates

**API Endpoint:**

```http
POST /api/trip/location
Authorization: Bearer <encrypted_token>
Content-Type: application/json

{
  "tripId": "...",
  "coordinates": [31.2357, 30.0444],  // [lng, lat]
  "accuracy": 10,
  "timestamp": 1703251200000
}
```

### التدفق الكامل:

```
Mobile App (كل 20 ثانية)
    ↓
POST /api/trip/location
    ↓
trip.controllers.js → updateLocation()
    ├─ 1. يحفظ في MongoDB (Order.clientMovement / guideMovement)
    ├─ 2. يحدث Redis (tripStateManager)
    └─ 3. يستدعي safetyOrchestrator.processLocationUpdate()
        ↓
    [بدء طبقات الأمان]
```

---

## 🛡️ طبقات الأمان (Safety Layers)

### Layer 6: Speed Analyzer (تحليل السرعة مع التحقق من المركبة)

**الملف:** `services/safety/speedAnalyzer.js`

```javascript
const speedResult = await speedAnalyzer.analyzeSpeedWithVehicle(
  tripId,
  role,
  coordinates,
  timestamp,
  tripDetails,
);
```

**حدود السرعة حسب المركبة:**
| Type | Max | Highway | City |
|------|-----|---------|------|
| car/suv | 180 | 140 | 60 |
| bus | 120 | 100 | 50 |
| motorcycle | 200 | 140 | 60 |
| bicycle | 40 | 0 | 25 |
| none (walking) | 7 | 0 | 6 |

**كشف وسيلة النقل:**

- ✈️ `plane` (>400 km/h) → آمن تلقائياً
- 🚂 `train` (80-350 km/h + avg high) → آمن تلقائياً
- 🚤 `boat` (10-80 km/h + avg low) → آمن تلقائياً

**يكتشف:**

- ✅ `walking` (0-7 km/h)
- ✅ `vehicle` (20-120 km/h)
- ⚠️ `sudden_stop` (توقف مفاجئ)
- ⚠️ `sudden_acceleration` (تسارع مفاجئ)
- ⚠️ `exceeds_vehicle_capability` (سرعة أعلى من قدرة المركبة)
- ❌ `impossible_speed` (>180 km/h) → خطأ GPS

**تدفق التحذير:**

```javascript
if (speed > vehicleLimit.highway) {
  // استخدام flexibleResponseService لإرسال تحذير مستمر
  await flexibleResponseService.sendQuestion(
    tripId,
    touristId,
    "SPEED_LIMIT_EXCEEDED",
    { speed },
  );
}
```

**القرار:**

```javascript
if (speedResult.transportMode === "plane") {
  return SAFE; // على طيارة، لا مشكلة
}

if (speedResult.anomaly === "impossible_speed") {
  return GPS_ERROR; // يوقف المعالجة
}

if (speedResult.anomaly === "exceeds_vehicle_capability") {
  sendSpeedWarning(); // تحذير السائح
}
```

---

## 🛡️ طبقات الأمان (Safety Layers)

يتكون النظام من **15 طبقة أمان** متكاملة، تم تعزيزها مؤخراً بـ **ثلاث طبقات حرجة (The 3 Critical Upgrade Layers)** للارتقاء لمستوى "التأمين السياحي العالمي".

### Layer 1: ML Analyzer (Python Decision Engine - 35 Features) 🔄

**الملف:** `services/mlBrain/index.js` (Bridge) & `mlBrainpy/` (Python Engine at Root)

**كيف يعمل؟**
تم نقل منطق الـ ML بالكامل إلى **Microservice برمج بـ Python (FastAPI)** مع توسعة ضخمة للـ Feature Vector من 27 لـ **35 ميزة (Features)**:

1.  **Behavioral IQ (🆕):** يحلل النظام بصمة السلوك عبر **تجميع البيانات اللحظي (Aggregated Profiling)** من مصادر متعددة (Emergency, Chat, Reviews, Feedback). يتم تحسين الأداء عبر استعلامات تجميعية (**Aggregation Pipelines**) لتقليل الحمل على قاعدة البيانات.
2.  **التواجد المستمر (Health Monitoring):** يراقب السيرفر حالة خدمة الـ ML لحظياً. في حال الانقطاع، ينتقل تلقائياً لـ **وضع الاحتياط (Fallback Mode)** مع زيادة درجة الحذر في القرارات لضمان الأمان.
3.  **Multi-Head Architecture:** المحرك يعطي 4 مخرجات متزامنة:
    - **Risk Score:** نسبة الخطر الكلية (مدعومة بالسياق التاريخي).
    - **Context Decisions:** (هل نحتاج خرائط؟ هل نحتاج AI؟ هل نصعد للأدمن؟).
    - **Confidence:** مدى ثقة النموذج بناءً على نضج الداتا (Maturity).
    - **Layer Override:** التحكم الديناميكي في طبقات الأمان.
3.  **Bridge Client:** يعمل كود Node.js كـ HTTP Client يرسل الطلبات للـ Python مع نظام **Retry & Fallback**.
4.  **Personalized Maturity:** يراقب مستويات التعلم لكل مستخدم من Infant إلى Expert، ويضبط الحساسية بناءً على تاريخه المسجل.

---

### Layer 2: Map Verifier & POI (التحقق من الأماكن والخدمات) 🔄

**الملف:** `services/safety/mapVerifier.js`

**الوظيفة الأساسية:**
البحث عن "نقاط الاهتمام" (Points of Interest) للتأكد من منطقية التوقف:

- 🍽️ **مطاعم وكافيهات:** توقف منطقي لتناول الطعام.
- 🏨 **فنادق وأماكن إقامة:** توقف منطقي للاستراحة.
- ⛽ **محطات وقود وصيدليات:** توقف منطقي للخدمات.
- 🏛️ **معالم سياحية ومتاحف:** توقف منطقي للتنزه.

**التحقق من منطقية التوقف (`checkIfStopIsLogical`):**
عند توقف السائح، يفحص النظام المحيط؛ إذا وُجد مطعم أو معلم سياحي، يعتبر التوقف **منطقياً** ولا يزعج المستخدم بالأسئلة.

---

### Layer 2.5: Global Free & Multi-Map Resilience 🆕

**مدمج في:** `mapVerifier.js`

- **Prioritize Free:** السيستم بيفضل **OSM** عالمياً كمصدر أول للبيانات الضخمة (High Volume).
- **Localized Priority:** يعطي الأولوية لـ Yandex/Baidu في أقاليمها.
- **Paid Fallback:** يستخدم Google/HERE فقط لتكملة البيانات الناقصة أو في حالات الخطر الشديد.
- يدعم Circuit Breaker و Retry لضمان استمرارية الخدمة.

---

### Layer 3: AI Analyzer & Flexible Responses (الذكاء الاصطناعي والردود المرنة) 🔄

**الملف:** `services/safety/aiAnalyzer.js` & `services/flexibleResponseService.js`

**الميكانيكية التشغيلية:**

- **التحليل العميق المتفرق:** يحلل الموقف باستخدام Gemini AI إذا كانت الطبقات السابقة غير حاسمة، مع التركيز على فهم السياق الوصفي (مثل "زحام شديد" أو "تظاهرات").
- **نظام المراقبة الجريء (Fail-Loud Monitoring):** بخلاف الأنظمة التقليدية، يراقب السيرفر فشل الـ AI لحظياً. في حال تكرار الفشل (Consecutive Failures)، يتم تصعيد الأمر فوراً للأدمن باعتباره "تعطل في طبقة الحماية القصوى".
- **الإدارة المالية (Cost Observability):** يتم تتبع استهلاك الـ AI لكل مستخدم لضمان استدامة الخدمة دون المساس بجودة الأمان.
- **الردود المرنة:** توجيه أسئلة ذكية للسائح (Yes/No, Photo, Location) للتحقق من الواقع الميداني.
- **English-Only Output:** توحيد المخرجات لدعم دقة معالجة البيانات وتدريب نماذج المستقبل.

---

### Layer 4: Escalation Service (التصعيد للأدمن)

**الملف:** `services/safety/escalationService.js`

```javascript
await escalationService.escalateToAdmin(tripId, {
  reason: "no_response_to_safety_check",
  coordinates,
  aiAnalysis,
  responseHistory,
});
```

**ما يحدث:**

1. يحفظ في `emergencyAlert.models.js`
2. يرسل Socket.io للأدمن (إذا online)
3. يرسل FCM notification (إذا offline)
4. يسجل في Audit log

**Escalation Levels:**

```javascript
{
  WARNING_SENT: 1,
  NO_RESPONSE: 2,
  SECOND_WARNING: 3,
  ADMIN_NOTIFIED: 4,
  EMERGENCY: 5
}
```

---

### Layer 5: Distance Monitor (مراقبة المسافة)

**الملف:** `services/safety/distanceMonitor.js`

يراقب المسافة بين السائح والمرشد وينبه عند حدوث انفصال غير مبرر (>500m).

---

**Thresholds (تتغير حسب السياق):**

```javascript
NORMAL: 100m
WARNING: 300m
ALERT: 500m
CRITICAL: 1000m

// في المناطق السياحية المزدحمة:
threshold × 2.5
```

**القرار:**

```javascript
if (distance > CRITICAL) {
  // يرسل تنبيه للسائح والمرشد
  // يطلب تأكيد: هل الابتعاد متعمد؟
}
```

---

### Layer 7: Device Health Monitor (البطارية والشبكة)

**الملف:** `services/safety/deviceHealthMonitor.js`

**API Endpoint:**

```http
POST /api/trip/device-health

{
  "tripId": "...",
  "battery": 15,
  "signalStrength": "weak",
  "networkType": "2G",
  "isCharging": false
}
```

**يتوقع:**

```javascript
// يحسب معدل استهلاك البطارية
const drainRate = (previousBattery - currentBattery) / timePassed;
const minutesRemaining = currentBattery / drainRate;

if (minutesRemaining < 30) {
  // ينبه المرشد والأدمن قبل انقطاع الاتصال عبر flexibleResponseService
  await flexibleResponseService.sendQuestion(
    tripId,
    userId,
    "LOW_BATTERY_WARNING",
  );
}
```

---

### Layer 13: Temporal Risk & Time-Aware Threat Modeling 🔄

**الملف:** `services/safety/temporalRiskService.js` (تطوير لـ `timeSafetyAnalyzer.js`)

**يراقب:**

- 🌙 **الذكاء الزمني:** لا يعتمد على ساعات ثابتة، بل يحسب مواعيد الشمس (Sunrise/Sunset) لحظياً بناءً على إحداثيات الموقع الحالي.
- 🚨 **Legal Compliance (الامتثال القانوني):** يتحقق من قوانين الحظر (Curfew) والقيود الأمنية المؤقتة لكل دولة عبر `externalSafetyRulesService`.
- ⏱️ **Risk Modeling:** قياس تقلبات الخطر (Risk Volatility) بناءً على التوقيت والبيئة المحيطة.
- **ML Governance:** الـ ML يراقب ثبات القواعد ويقرر متى يتم تحديثها (Force Refresh).
- **Zero Hardcoded:** النظام يعتمد 100% على المصادر اللحظية والديناميكية.

---

### Layer 14: Holistic Spatial & Route Intelligence Layer 🆕

**الملف:** `services/safety/spatialRiskEngine.js` (تطوير لـ `locationReputationService.js`)

**الوظيفة:**
ينقل النظام من مجرد "تتبع نقطة" إلى "فهم البيئة المحيطة والوجهة":

- **Holistic Area Analysis:** يحلل سمعة الموقع الحالي، والمناطق المحيطة (Spillover Risks)، والوجهة المستهدفة (Destination) في وقت واحد.
- **Environment-Aware Vetting:** يميز بين البيئات الحضرية، السياحية، والنائئة لضبط حساسية التنبيهات.
- **Regional Engine Selection:** يوجه البحث لمحركات محلية (Yandex, Baidu) بناءً على `GeoConfig` لضمان دقة البيانات المكانية.

---

### Layer 15: Decision Orchestration Layer (Advisory Intelligence) 🆕

**الملف:** `services/safety/decisionOrchestrationService.js`

**الوظيفة:**
العقل المدبر الذي يحول مخرجات الـ ML والـ AI إلى "نصائح وتحذيرات" استباقية (Advisory-Only):

- **Multi-Source Aggregation:** يجمع القرارات من (Python ML Brain + Gemini AI + Temporal Risk + Spatial Risk).
- **Safety Playbooks (إرشادية فقط):** تنفيذ سيناريوهات أمان مسبقة الإعداد لضمان الحماية دون التدخل في حرية حركة المستخدم:
  - `CRITICAL_ADVISORY`: تحذير شديد اللهجة للمستخدم وتنبيه فوري للأدمن (Audit Trail).
  - `REROUTE`: اقتراح مسارات بديلة آمنة وتوضيح المخاطر في المسار الحالي.
  - `DELAY`: التوصية بالانتظار في الموقع الحالي (مثل مطعم أو فندق آمن) حتى يزول الخطر المكاني أو الزماني.
  - `MONITOR_INTENSE`: زيادة كثافة المراقبة الصامتة وتوثيق الأدلة تحسباً لأي طوارئ.
- **Audit Logging:** النظام لا يوقف الرحلة أبداً، ولكنه يسجل كافة التحذيرات بدقة متناهية لتكون مرجعاً قانونياً وتوثيقياً في حالة حدوث أي مكروه.
- **Adaptive Intensity:** ضبط تكرار فحص الأمان بناءً على "درجة الثقة" (User Trust Score) لتجنب الإزعاج (Phase 14).

---

### Layer 9: Route Monitor (مراقبة المسار) 🆕

**الملف:** `services/safety/routeMonitor.js`

**الوظائف الرئيسية:**

```javascript
// تحديد الموقع كمزور عند الوصول (50 متر)
await routeMonitor.markLocationVisited(tripId, coordinates, tripDetails);

// التحقق من الانحراف عن المسار
const routeResult = await routeMonitor.checkRoute(
  tripId,
  coordinates,
  tripDetails,
);
```

**تتبع الزيارات:**

```javascript
// في Order Schema:
locations: [
  {
    name: "Pyramids of Giza",
    coordinates: [31.1342, 29.9792],
    visited: false, // ← يتحول لـ true عند الوصول
    visitedAt: null, // ← يحفظ وقت الزيارة
  },
];
```

**كشف الانحراف:**

```
Location Update
    ↓
هل قريب من موقع مخطط (<50m)?
    ├─ نعم → ✅ markLocationVisited()
    └─ لا → هل على طريق لأي موقع (<500m)?
              ├─ نعم → continue monitoring
              └─ لا → هل في مطعم/محطة وقود؟
                        ├─ نعم + وقف → OK
                        ├─ نعم + عدى → اسأل السائح
                        └─ لا → اسأل السائح
```

**أسئلة الانحراف:**

```javascript
{
  first_deviation: {
    question: "You seem to be off the planned route. Is this intentional?",
    options: [
      "Yes, we're exploring",
      "Taking a different route",
      "I'm not sure where we are"
    ],
    maxWaitTime: 60 // ثانية
  },
  confirm_deviation: {
    question: "Please confirm - do you know where you're going?",
    options: ["Yes, I know", "No, I need help"],
    maxWaitTime: 120 // ثانية
  }
}
```

**التصعيد:**

```javascript
if (no response after 2 minutes) {
  // ينبه المرشد
  alertGuideOfDeviation(tripId, tripDetails);
}

if (response === "no_lost" || "no_help") {
  // تصعيد فوري للمرشد
  alertGuideOfDeviation(tripId, tripDetails);
}
```

**API Endpoints:**

```http
POST /api/trip/route-response
{
  "tripId": "...",
  "response": {
    "id": "yes_exploring",
    "details": "Going to a nearby cafe"
  }
}

GET /api/trip/:tripId/progress
// Returns: { visitedCount: 3, totalCount: 5, percentComplete: 60 }
```

---

### Layer 10: Data Collector (جمع البيانات وحلقة التعلم) 🔄

**الملف:** `services/safety/dataCollector.js`

**الوظيفة:**
يقوم النظام بجمع **البيانات الخام (Raw Data)** وتخزينها في `SafetyTrainingData` لدعم حلقة التعلم المستمر:

- **Raw Context:** إحداثيات، سرعة، زاوية الحركة، حالة الجهاز.
- **Aggregated User Profiles (🆕):** تخزين "بصمة السلوك" (Trust, Risk, Chat Rate, Review Rating) في لقطة البيانات (Snapshot) وقت الحدث.
- **Labels:** ربط البيانات بالنتيجة الفعلية (Outcome) لتصحيح أوزان النموذج.
- **Benefit:** يسمح للـ Python service بإعادة معالجة البيانات (Feature Engineering) بالكامل دون تغيير كود الـ Node.js، مما يسهل إضافة Features جديدة في المستقبل.

---

### Layer 11: Location Reputation Service (سمعة المكان) 🆕

**الملف:** `services/safety/locationReputationService.js`

**الوظيفة:**
يفحص سمعة المنطقة الأمنية باستخدام مصادر متعددة:

- **Hybrid Deep Scan:** يدمج بحث الويب (Google, Bing) مع سياق الخريطة (أقسام شرطة، مناطق خطرة).
- **History Tracking:** يتذكر السمعة السابقة للمواقع التي زارها السائح في نفس الرحلة.
- **Multilingual Search:** يبحث باللغة المحلية للبلد (عبر `GeoConfig`) لضمان العثور على الأخبار المحلية، لكن يترجم النتيجة للإنجليزية.

---

### Layer 12: Video Risk Intelligence (ذكاء الفيديو اللحظي) 🆕

**الملف:** `services/safety/videoRiskAnalyzer.js`

**القدرات الجديدة:**

1. **YouTube Data API Integration:** كشف ما يسمى "Sari'a Sari'a" (سريع جداً) للأحداث المباشرة (Live Streams) والعاجلة.
2. **Multimodal Analysis:** استخدام **Gemini 1.5 Flash** لتحليل صور الـ Thumbnails بصرياً للكشف عن (حرائق، تجمعات، سلاح) بدلاً من الاعتماد على النص فقط.
3. **Smart Recency Scoring:** خوارزمية دقيقة تحسب "نقاط الحداثة" (Recency Score) للفيديو وتعطي أولوية قصوى للبث المباشر.
4. **Keyword Shield:** يستخدم كلمات مفتاحية بلغة البلد (مثل "عاجل"، "مباشر") لفلترة المحتوى بدقة قبل التحليل المكلف.

---

### Layer 13: Predictive Open-World Analysis (Trajectory Bridge) 🔄

**الملف:** `services/mlBrain/MotionTrajectoryBrain.js` (Bridge) & `mlBrainpy/` (Root Level)

تم تحويل تحليل المسارات ليتم برمجياً داخل Python:

1. **أفق التنبؤ (60-Minute Horizon):** يتنبأ بمسار المستخدم بناءً على شعاع الحركة (Vector).
2. **التحقق الصامت (Silent Vetting):** تحليل خلفي للانحرافات للتأكد من منطقيتها (توقف لخدمة أو عودة قريبة).
3. **Connectivity:** يتصل بـ `/api/v1/trajectory/analyze` في خدمة الـ ML.

---

### Phase 3 & 4 Optimizations 🔧

**تحسينات الأداء والهيكلة:**

1. **Config Centralization:** جميع إعدادات الأمان متاحة عبر `/api/system/safety/config` لقراءة القيم الحالية.
2. **Distance Normalization:** زيادة نطاق التطبيع إلى 50km لدعم الرحلات الطويلة.
3. **Online Learning Persistence:** حفظ النماذج بشكل دوري بعد التحديثات اللحظية.
4. **Unified Config:** تنظيف التكرارات في ملفات التكوين.

---

### Layer 14: Smart Monitoring & Optimization (Phase 6) 🆕

**الملف:** `services/safetyOrchestrator.js`

**تحسين استهلاك الموارد:**

1. **Stationary & Safe Optimization:**
   - إذا كان الموقع "آمن" (Verified Safe) والـ ML واثق بنسبة > 80%، يتم تخطي الـ AI والخرائط تماماً.
   - إذا توقف السائح في مكان آمن لأكثر من 5 دقائق، يتم الاكتفاء بمراقبة Geofence بسيطة (<50m).
2. **Dual Monitoring Mode:**
   - **Together (<100m):** يتم تحليل **السائح فقط**.
   - **Separated (>100m):** تفعيل التحليل الكامل للطرفين.
3. **Solo Logic Support:**
   - تعطيل إنذارات "الخروج عن المسار" (Off-route) تماماً في وضع `undefined destination` (Exploration mode).
   - تعطيل كافة فحوصات "تباعد المرشد" و "نقطة التجمع" لرحلات السولو.

---

## 🌟 نظام التقييم الهجين (Hybrid Feedback Flow) 🆕

**الملف:** `services/tripFeedbackService.js`

### التدفق (Phase 12/13):

1. **الزناد:** انتهاء الرحلة + 30 دقيقة انتظار.
2. **التحقق:** هل قام المستخدم بالتقييم يدوياً بالفعل عبر الـ API؟
   - نعم ← توقف، لا ترسل شيئاً.
   - لا ← أرسل طلب التقييم.
3. **الإرسال:** يتم الإرسال عبر **Socket.io** (أولوية) و **FCM Push** في نفس اللحظة.
4. **الأسئلة:** تشمل تقييم الأمان، تقييم المرشد، وسؤال خاص بـ **UX التتبع**.
5. **Solo Adaptation:** إذا كانت الرحلة فردية (`solo_system`)، يتم طرح أسئلة مختصرة عن "تجربة النظام" فقط (System Safety & Experience) بدلاً من تقييم المرشد، وتكون الوجهة `toUserId: null`.
6. **الاستقبال:** يستقبل السيرفر الإجابات عبر `POST /api/trip/:tripId/feedback`.

---

## 🧠 حلقة التعلم الشخصي (ML Personalization Loop) 🆕

**الملف:** `services/mlBrain/decisionEngine.js` & `services/tripFeedbackService.js`

### كيف يتغير النظام لكل مستخدم؟ (Phase 14)

1. **Fetch Configuration:** يقوم `dataPreprocessor` بجلب خطة المستخدم (`safetyConfig`) من قاعدة البيانات (Free vs Premium).
2. **تحليل الردود:** يتم استخراج "كلمات مفتاحية" من رأي المستخدم (مثل: "الرسايل كتير"، "محتاج تتبع أدق").
3. **تحديث الـ Features:** يتم تحويل هذه التفضيلات إلى أرقام (Features) تدخل في حسابات الـ ML.
4. **القرار الذكي (`decisionEngine.js`):**
   - **Personalized Thresholds:** يطبق عتبات مخاطر مختلفة بناءً على الخطة.
   - لو المستخدم "Free" وموثوق: يقلل التنبيهات لتوفير التكلفة.
   - لو "Premium": يحافظ على رقابة لصيقة حسب الطلب.
5. **تعديل الـ Intensity:** يتم خفض شدة المراقبة (Monitoring Intensity) للمستخدمين الموثوقين الذين فضلوا "المراقبة الصامتة".

### Global Model Learning (Multi-Model Integration) 🆕

**الملف:** `services/mlBrainPy/trainer.py` & `services/mlBrainPy/db_connector.py`

**نظام التعلم الشامل:**
النظام أصبح لديه **رؤية كاملة** وكشف شامل على كافة البيانات لربط الأمان بالسلوك:

- **Cross-Model Learning:** الموديل بيتعلم من:
  - **EmergencyAlert**: حالات الطوارئ السابقة وعلاقتها بالموقع.
  - **Chat**: كلمات الخطر في المحادثات الرسمية.
  - **Review**: كيف يؤثر تقييم المستخدم على معدل المخاطر.
- **Ground Truth Logic:** يربط بين RISK PREDICTION والنتيجة الفعلية للرحلة (Trip Outcome) لتصحيح نفسه آلياً وإعادة ترتيب أوزان الـ Features الثلاثة والثلاثين.

**الملف:** `services/meetingPointService.js`

### الوظائف:

```javascript
// فحص الوصول لنقطة التجمع
const result = await meetingPointService.checkArrivalAtMeetingPoint(
  tripId,
  role,
  coordinates,
);

// التحقق من المسافة (300م)
const validation = await meetingPointService.validateMeetingPointDistance(
  tripId,
  coordinates,
);
```

### المنطق:

```
إذا وصل طرف لنقطة التجمع:
  ├─ إشعار الطرف الآخر
  └─ بدء مؤقت الانتظار

إذا الطرف الآخر بعيد:
  ├─ متحرك باتجاه النقطة → انتظار
  ├─ ثابت في الطريق → 30 دقيقة سماح
  └─ لم يبدأ → 15 دقيقة ثم رسوم

إذا المسافة > 300م:
  └─ إشعار "أنت في المكان الخطأ"
```

### الـ Thresholds:

```javascript
MEETING_POINT_RADIUS = 300; // متر
TOURIST_WAIT_TIME = 15 * 60; // 15 دقيقة
ONROUTE_WAIT_TIME = 30 * 60; // 30 دقيقة
```

---

## 💰 Trip Completion Service - إكمال الرحلة والدفع 🆕

**الملف:** `services/tripCompletionService.js`

### طلب إكمال الرحلة:

```javascript
// الطرف الأول يطلب الإنهاء
const result = await tripCompletionService.requestTripCompletion(
  tripId,
  userId,
  role,
);
// → { status: "waiting_for_confirmation", confirmedBy: "tourist" }
// (ملاحظة: في حالة "Solo Trip"، يتم الإنهاء فوراً بطلب السائح دون انتظار تأكيد طرف ثانٍ)

// الطرف الثاني يؤكد
// → التدفق التلقائي:
//   1. حساب المبلغ النهائي
//   2. إضافة ديون السائح السابقة
//   3. حساب عمولة 5%
//   4. تحديث المحافظ
```

### حساب المبلغ:

```javascript
finalAmount = tripPrice + touristDebt
commission = tripPrice * 5%

// السائح يدفع للمرشد: finalAmount
// المرشد يدفع للمنصة: commission
```

### الإلغاء:

```javascript
const result = await tripCompletionService.handleCancellation(
  tripId,
  userId,
  reason,
  duringExecution,
);
```

| الحالة        | الرسوم                 |
| ------------- | ---------------------- |
| قبل 24 ساعة   | 10% للطرف الآخر        |
| أثناء التنفيذ | `requiresReview: true` |
| No-show       | 10% للطرف المنتظر      |

### ملخص الدفع:

```javascript
const summary = await tripCompletionService.getPaymentSummary(tripId);
// → {
//     tripPrice: 100,
//     touristDebt: 5,
//     totalForTourist: 105,
//     commission: 5,
//     guideReceives: 100
// }
```

---

## ️ Admin & System Health Tools 🆕

**الملف:** `services/mlBrain/adminCommunicator.js`

### 1. ML Model Health Report

يعرض حالة "عقل" النظام (Async & Validated):

- دقة النموذج (Accuracy Trend)
- إصدار النموذج (Model Version)
- عدد الحالات التي تعلم منها (Total Samples)
- **Last Loss Metric:** بدلاً من الأوزان الخطية، نعرض آخر قيمة خسارة (Validation Loss) للدقة التقنية.

### 2. Search Engine Benchmark

أداة لقياس كفاءة محركات البحث:

- تقارن النتائج بين Google, Bing, DuckDuckGo
- تقيس دقة تحليل المشاعر لكل محرك

### 3. Manual Reputation Check

أداة لفحص أي موقع يدوياً:

- يدخل الأدمن الإحداثيات -> يحصل على تقرير أمني شامل (Web + Map Safety Score).

---

## 🔄 Safety Orchestrator - المنسق الرئيسي

**الملف:** `services/safetyOrchestrator.js`

### التدفق الكامل:

```javascript
async function processLocationUpdate(tripId, role, coordinates, tripDetails) {
  // 0. تحديد الموقع كمزور (إذا كان قريباً من موقع مخطط)
  await routeMonitor.markLocationVisited(tripId, coordinates, tripDetails);

  // 1. Speed Analysis (مع التحقق من المركبة)
  const speedResult = await speedAnalyzer.analyzeSpeedWithVehicle(tripId, role, coordinates, timestamp, tripDetails);
  if (speedResult.transportMode === "plane" || speedResult.transportMode === "train") {
    return SAFE; // على طيارة أو قطار
  }
  if (speedResult.anomaly === "impossible_speed") return GPS_ERROR;

  // 2. Route Monitoring (للسائح فقط بعد التقابل)
  if (state.hasMet && role === "tourist") {
    const routeResult = await routeMonitor.checkRoute(tripId, coordinates, tripDetails);
    if (routeResult.status === "off_route" && routeResult.deviationCount >= 3) {
      // سيرسل سؤال للسائح تلقائياً
    }
  }

  // 3. Time Analysis
  const timeRisk = timeSafetyAnalyzer.analyzeTimeRisk(tripDetails);

  // 4. ML Analysis (مع السياق)
  const mlResult = await mlAnalyzer.analyzeLocation(...);
  mlResult.speedContext = speedResult;
  mlResult.timeContext = timeRisk;

  // 5. Smart Decision
  if (mlResult.confidence > 80 && safe && timeRisk !== "high") {
    return SAFE; // ✅ لا داعي للطبقات الأخرى
  }

  if (mlResult.skipToLayer === 3 || timeRisk === "high") {
    return await runAILayer(...); // ⚡ تخطي Maps، اذهب للـ AI
  }

  // 6. Map Verification
  const mapResult = await mapVerifier.verifyLocation(...);
  if (mapResult.safe && timeRisk !== "high") {
    return SAFE;
  }

  // 7. AI Analysis (إذا لزم الأمر)
  if (mapResult.unsafe || speedAnomaly) {
    return await runAILayer(...);
  }

  // 8. Distance Check (دائماً)
  await distanceMonitor.checkDistance(tripId, tripDetails);
}
```

---

## 💾 Redis State Management

**الملف:** `services/tripStateManager.js`

**يحفظ:**

```javascript
{
  tripId: "...",
  status: "in_progress",
  hasMet: true,
  lastGuideLocation: [31.2, 30.0],
  lastTouristLocation: [31.21, 30.01],
  lastGuideUpdate: 1703251200000,
  lastTouristUpdate: 1703251220000,
  escalationLevel: 0,
  pendingResponse: {
    type: "wellbeing_check",
    sentTo: "userId",
    sentAt: 1703251200000
  },
  speedAnomaly: { ... },
  distanceLevel: "normal",
  responseHistory: [ ... ]
}
```

**TTL:** 24 hours

---

## 🔔 Notification System

### 1. Socket.io (Real-time)

**Safety Questions:**

```javascript
io.to(socketId).emit("safety_question", {
  tripId,
  question: "Is everything okay?",
  options: [
    { id: "yes_safe", label: "Yes, I'm safe" },
    { id: "need_help", label: "I need help" },
  ],
});
```

**Route Deviation Questions:** 🆕

```javascript
io.to(socketId).emit("route_deviation_question", {
  tripId,
  questionType: "route_deviation",
  question: "You seem to be off the planned route. Is this intentional?",
  options: [
    { id: "yes_exploring", label: "Yes, we're exploring" },
    { id: "yes_shortcut", label: "Taking a different route" },
    { id: "no_lost", label: "I'm not sure where we are" },
  ],
});
```

**Location Visited:** 🆕

```javascript
io.to(socketId).emit("location_visited", {
  tripId,
  locationName: "Pyramids of Giza",
  visitedCount: 3,
  totalCount: 5,
  percentComplete: 60,
});
```

**Speed Warning:** 🆕

```javascript
io.to(socketId).emit("speed_warning", {
  tripId,
  speed: 155,
  vehicleType: "car",
  message: "For your safety, please slow down...",
});
```

**Tourist Deviation Alert (للمرشد):** 🆕

```javascript
io.to(guideSocketId).emit("tourist_deviation_alert", {
  tripId,
  message: "Tourist is off route and not responding",
  touristLocation: [31.2, 30.0],
});
```

### 2. FCM (Push Notifications)

```javascript
await NotificationService.sendToMultipleDevices(
  fcmTokens,
  "Safety Check",
  "Please confirm you're safe",
  { tripId, type: "safety_question" },
);
```

### 3. Email (Confirmations)

```javascript
await sendGemail(userEmail, "Trip Started", emailTemplate);
```

---

## 📊 Monitoring & Metrics

**الملف:** `monitoring/metrics.js`

**Prometheus Metrics:**

```javascript
MetricsCollector.recordLocationUpdate(country);
MetricsCollector.recordTripStart(country, guideId);
MetricsCollector.recordSchedulerRun();
```

**Health Checks:**

```http
GET /health/live   # Kubernetes liveness
GET /health/ready  # Kubernetes readiness
GET /metrics       # Prometheus metrics
```

---

## 🔐 Security & Authentication

### Token Flow:

```
1. User logs in → users_Payment server
2. JWT generated → encrypted with AES-256
3. Encrypted token sent to client
4. Client sends encrypted token in headers
5. Trip-Monitoring decrypts → verifies → validates
6. Token cached in Redis (7 days TTL)
```

**الملف:** `util/encryption.js`

```javascript
const { client: redisClient, connectRedis } = require("../config/redis");

// يستخدم Redis المشترك من config/redis.js
await cacheToken(tokenHash, decodedToken, 604800);
```

---

## 📁 File Structure

```
Trip-Monitoring/
├── app.js                          # Entry point
├── bin/www                         # Server startup
├── config/
│   ├── conectet.js                 # MongoDB (3 databases)
│   ├── redis.js                    # Redis client (shared)
│   ├── firebase.js                 # FCM
│   └── geoConfig.js                # [NEW] Geo-Aware Config (Langs & Countries) 🆕
├── models/
│   ├── order.models.js             # Trip orders
│   ├── users.models.js             # Users, Wallet, KYC
│   ├── emergencyAlert.models.js    # Emergency alerts
│   └── ml.model.js                 # SafetyEvent (ML data)
├── controllers/
│   ├── trip.controllers.js         # Location updates
│   ├── order.controllers.js        # Tourist operations
│   └── order.guide.controllers.js  # Guide operations
├── routes/
│   ├── tripMonitoring.js           # Trip routes
│   ├── order.js                    # Order routes
│   └── chat.js                     # Chat routes
├── services/
│   ├── initServices.js             # Service initializer
│   ├── tripScheduler.js            # Trip scheduler
│   ├── tripStateManager.js         # Redis state
│   ├── safetyOrchestrator.js       # Main coordinator
│   ├── meetingPointService.js      # Meeting point logic
│   ├── tripCompletionService.js    # Completion & payment
│   ├── flexibleResponseService.js  # [NEW] Unified Response System 🆕
│   ├── externalSafetyRulesService.js # [NEW] Dynamic Rule Fetcher 🆕
│   ├── notificationQueueService.js # [NEW] Priority & Rate-limited Notify 🆕
│   ├── mlBrain/                    # [REFAC] ML Bridge Layer 🆕
│   │   ├── index.js                # Bridge to Python ML
│   │   ├── config.js               # ML Parameters & Thresholds
│   │   └── MotionTrajectoryBrain.js # Trajectory Bridge
│   ├── mlBrainPy/                  # [NEW] Python ML Microservice 🆕
│   │   ├── api.py                  # FastAPI Endpoints
│   │   ├── trainer.py              # Training Engine
│   │   ├── db_connector.py         # MongoDB Integrated Connector
│   │   └── data_preprocessor.py    # Feature Extraction (Python)
│   │   └── ....
│   └── safety/
│       ├── mlAnalyzer.js           # Layer 1: ML Decision Engine
│       ├── mapVerifier.js          # Layer 2: Map Verification (Multi-Provider)
│       ├── aiAnalyzer.js           # Layer 3: AI Threat Analysis
│       ├── escalationService.js    # Layer 4: Admin Escalation
│       ├── distanceMonitor.js      # Layer 5: Distance Monitoring
│       ├── speedAnalyzer.js        # Layer 6: Speed Analysis (vehicle-aware)
│       ├── deviceHealthMonitor.js  # Layer 7: Device Health (Battery/Signal)
│       ├── timeSafetyAnalyzer.js   # Layer 8: Time Risk Analysis (dynamic solar)
│       ├── routeMonitor.js         # Layer 9: Route Monitoring
│       ├── dataCollector.js        # Layer 10: ML Data Collection
│       ├── locationReputationService.js # Layer 11: Location Reputation
│       ├── videoRiskAnalyzer.js    # Layer 12: Video Risk Intelligence
│       ├── temporalRiskService.js  # Layer 13: Temporal Risk Analysis
│       ├── spatialRiskEngine.js    # Layer 14: Spatial Risk Analysis
│       ├── decisionOrchestrationService.js # Layer 15: Decision Orchestration
│       ├── helper/
│       │   └── predictiveSafety.js # Layer 13: Trajectory Brain 🆕
│       └── shard/
│           └── searchEngineAggregator.js # Support: Multi-Search Engine
├── middlewares/
│   ├── verifytoken.js              # JWT verification
│   ├── security.js                 # Security middleware
│   └── RemainingAccount.js         # Financial checks
├── util/
│   ├── encryption.js               # AES-256 + Redis cache
│   ├── paymentUtils.js             # Commission, fees
│   ├── circuitBreaker.js           # [NEW] Resilience: Circuit Breaker 🆕
│   ├── retryMechanism.js           # [NEW] Resilience: Retry Engine 🆕
│   ├── auditLogger.js              # Audit logging
│   └── tripUtils.js                # [NEW] Conflict & Time Management 🆕
└── monitoring/
    ├── metrics.js                  # Prometheus
    └── health.js                   # Health checks
```

---

## 🔐 Security & Encryption - نظام الأمان والتشفير

### Architecture Overview

```
users_Payment Server (Auth Server)
    ↓ [User Login]
    ↓ [Generate JWT + Encrypt with AES-256]
    ↓ [Return: encrypted_token]
Mobile App
    ↓ [Store token in Keychain/Keystore]
    ↓ [Send: auth-token header]
Trip-Monitoring Server
    ↓ [Token Validation Middleware]
    ↓ [Decrypt + Verify JWT]
    ↓ [Grant/Deny Access]
```

### Token Flow

| Step | Server          | Action                    |
| ---- | --------------- | ------------------------- |
| 1    | users_Payment   | User login → Generate JWT |
| 2    | users_Payment   | Encrypt JWT with AES-256  |
| 3    | Mobile App      | Store encrypted token     |
| 4    | Trip-Monitoring | Decrypt token             |
| 5    | Trip-Monitoring | Verify JWT signature      |
| 6    | Trip-Monitoring | Check expiry              |

### Encryption (AES-256-CBC)

**File:** `util/encryption.js`

```javascript
// Encrypt data (JWT or Object)
const encrypted = encrypt(data);
// → Format: "iv_hex:encrypted_hex"

// Decrypt data (Smart - returns JWT string or parsed object)
const decrypted = decrypt(encryptedData);
```

**How it works:**

1. Key derived using `scrypt(ENCRYPTION_KEY, 'salt', 32)`
2. Random 16-byte IV for each encryption
3. AES-256-CBC cipher
4. Result: `iv:encryptedData` (hex format)

### Redis Token Caching

```javascript
// Cache token for fast access (7 days TTL)
await cacheToken(tokenHash, decodedToken);

// Get from cache or fallback to DB
const token = await getFromCacheOrDB(tokenHash, fallbackFn);

// Clear cache on logout
await clearTokenCache(tokenHash);
```

### Device Fingerprinting

**File:** `middlewares/security.js`

```javascript
// Required Headers from Mobile App:
const headers = {
  "x-device-id": "UUID", // Unique device ID
  "x-app-version": "1.0.0", // App version
  "x-platform": "ios|android", // Platform
  "User-Agent": "app-user-agent", // User agent
};

// Fingerprint = SHA256(deviceId + userAgent + appVersion + platform)
```

### Security Middleware Chain

```
Request
  ↓
1. Token Validation (/health, /metrics bypass)
  ↓
2. HTTPS Enforcement (403 if not HTTPS)
  ↓
3. Helmet Security Headers
  ↓
4. Device ID Validation (format check)
  ↓
5. Mobile-Only Access (block browsers/Postman in production)
  ↓
6. CORS (no origin = mobile app OK)
  ↓
7. Rate Limiting (by device-id or IP)
  ↓
8. Data Sanitization (Mongo/XSS/HPP)
  ↓
Route Handler
```

### Rate Limiting

```javascript
const config = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Max requests per window
  keyGenerator: (req) => req.get("x-device-id") || req.ip,
};
```

### CORS Configuration

```javascript
// Mobile apps: OK (no origin header)
// Listed origins: OK
// Browsers/Test tools: BLOCKED in production

const allowedHeaders = [
  "Content-Type",
  "Authorization",
  "auth-token",
  "x-device-id",
  "x-app-version",
  "x-platform",
];
```

### Request Signing (Optional)

```javascript
// HMAC-SHA256(body, appSecret)
const isValid = verifyRequestSignature(signature, body, appSecret);

// Timestamp validation (prevent replay attacks)
const isFresh = verifyTimestamp(timestamp); // ±5 min window
```

### App Version Validation

```javascript
validateAppVersion(appVersion);
// → { valid: true } or { valid: false, requireUpdate: true }
```

### Environment Variables

```env
# Token & Encryption
JWT_SECRET=your-jwt-secret
ENCRYPTION_KEY=your-32-char-key

# Device Security
DEVICE_FINGERPRINT_REQUIRED=true
MAX_DEVICES_PER_USER=5

# HTTPS/TLS
ENFORCE_HTTPS=true
HSTS_MAX_AGE=31536000

# Rate Limiting
RATE_LIMIT_WINDOW_MOBILE=15
RATE_LIMIT_MAX_MOBILE=200
```

### 🛡️ Security Protection (الحماية من الهجمات)

| الهجوم                                | الحماية                         | المكتبة/الآلية              |
| ------------------------------------- | ------------------------------- | --------------------------- |
| **XSS** (Cross-Site Scripting)        | تنظيف المدخلات                  | `xss-clean`                 |
| **NoSQL Injection**                   | تنظيف MongoDB queries           | `express-mongo-sanitize`    |
| **HTTP Parameter Pollution**          | منع تكرار المعاملات             | `hpp`                       |
| **Clickjacking**                      | منع iframe embedding            | `helmet` (X-Frame-Options)  |
| **MIME Sniffing**                     | منع تخمين نوع الملف             | `helmet` (noSniff)          |
| **Man-in-the-Middle**                 | فرض HTTPS + HSTS                | HTTPS Enforcement           |
| **Replay Attacks**                    | Timestamp validation (±5 min)   | `verifyTimestamp()`         |
| **Brute Force**                       | Rate limiting بالـ device-id    | `express-rate-limit`        |
| **Token Theft**                       | Token expiry + rotation         | JWT + Redis cache           |
| **Session Hijacking**                 | Device fingerprint verification | `verifyDeviceFingerprint()` |
| **CSRF** (Cross-Site Request Forgery) | No cookies + mobile-only        | CORS + no credentials       |
| **Server Fingerprinting**             | إخفاء Express                   | `x-powered-by: disabled`    |
| **Browser Access**                    | حظر المتصفحات                   | Mobile-only middleware      |
| **Test Tools**                        | حظر Postman/curl في production  | User-Agent check            |

**Headers المضافة بواسطة Helmet:**

```
Content-Security-Policy: default-src 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: no-referrer
```

---

## 🎯 Complete Flow Example

### سيناريو: سائح يبدأ رحلة

```
1. Trip Scheduler (كل دقيقة)
   ├─ يجد رحلة TripDate = الآن
   ├─ يحولها لـ "Gathering_time"
   └─ يرسل FCM: "Trip starts in 30 min"

2. السائح والمرشد يصلان لنقطة الالتقاء
   ├─ Mobile App يرسل: POST /api/trip/location
   └─ safetyOrchestrator.checkMeetingPoint()
       ├─ distance < 50m → hasMet = true
       ├─ يحول الرحلة لـ "in_progress"
       └─ يرسل: "Great! You've met. Enjoy!"

3. أثناء الرحلة (كل 20 ثانية)
   ├─ POST /api/trip/location
   └─ processLocationUpdate()
       ├─ Speed: 45 km/h (vehicle) ✅
       ├─ Time: 14:00 (safe) ✅
       ├─ ML: confidence 85%, safe ✅
       └─ Distance: 50m (normal) ✅
       → return { status: "safe" }

4. السائح يتوقف فجأة في مكان غريب
   ├─ Speed: 0.2 km/h (sudden_stop) ⚠️
   ├─ ML: no_data (مكان جديد) ⚠️
   └─ Map: no places found (remote) ⚠️
       → skipToLayer: 3 (AI)

5. AI Analysis
   ├─ Gemini: "Remote area, sudden stop"
   ├─ shouldAskUser: true
   └─ question: "Is everything okay?"
       → Socket.io + FCM notification

6. السائح لا يرد (60 ثانية)
   ├─ Second warning sent
   └─ لا يرد مرة أخرى (60 ثانية)
       → escalateToAdmin()

7. Admin Notification
   ├─ Socket.io → Admin dashboard
   ├─ FCM → Admin phone
   └─ emergencyAlert created in DB

8. السائح يرد: "I'm safe, just resting"
   ├─ escalationLevel → 0
   ├─ pendingResponse → null
   └─ ML learns: wasCorrectPrediction = false
       → weights updated in Redis
```

---

## 🔧 Environment Variables

```env
# MongoDB
MONGODB_URI_USERS=mongodb://...
MONGODB_URI_ORDERS=mongodb://...
MONGODB_URI_AUDIT=mongodb://...

# Redis
REDIS_URL=redis://localhost:6379
REDIS_DB=1

# Security
JWT_SECRET=...
ENCRYPTION_KEY=...
CRYPTO_SECRET=...

# APIs
GOOGLE_MAPS_API_KEY=...
GEMINI_API_KEY=...
YOUTUBE_API_KEY=...

# Firebase
FIREBASE_PROJECT_ID=...
FIREBASE_PRIVATE_KEY=...

# ML Brain Python Service
ML_BRAIN_URL=http://ml-brain:8000
ML_BRAIN_ENABLED=true
ML_BRAIN_TIMEOUT=5000
ML_BRAIN_PRODUCTION=true

```

---

## 📈 Performance Optimizations

1. **Redis Caching:**
   - Token cache (7 days)
   - Trip state (24 hours)
   - ML weights (5 minutes)

2. **Smart Layer Skipping:**
   - ML confidence > 80% → skip Maps & AI
   - ML confidence > 80% + dangerous → skip Maps, go to AI
   - Saves API calls & processing time

3. **Batch Processing:**
   - Location updates: max 500 per trip
   - Speed history: max 20 entries
   - Response history: unlimited (for learning)

---

4. **Parallel Execution:**
   - Distance check runs in parallel
   - Multiple notifications sent concurrently

5. **Distributed Scheduler Locking:** 🆕
   - يستخدم **Redis Locking (SETNX)** لمنع تكرار مهام التدريب اليومي في بيئات الـ Microservices المتعددة.

---

## 🚨 Error Handling

```javascript
// GPS Error
if (impossible_speed) → return GPS_ERROR

// Redis Error
if (redis.error) → fallback to DB

// API Error (Maps/AI)
if (api.error) → use fallback layer

// No Response
if (timeout) → escalate to admin
```

---

## 📝 Logging & Audit

**Audit Log:**

```javascript
await auditLog(userId, ip, "safety_response", {
  tripId,
  response: "yes_safe",
  result: "resolved",
});
```

**Prometheus Metrics:**

```
trip_location_updates_total{country="EG"}
trip_starts_total{country="EG", guide="..."}
trip_scheduler_runs_total
```

---

## 🎓 Learning System

**ML يتعلم من:**

```javascript
await mlAnalyzer.updateFromOutcome(eventId, wasCorrect, actualOutcome);

// يحدث الأوزان:
if (wasCorrect) {
  weights.mlConfidence += 0.05;
} else {
  weights.mlConfidence -= 0.05;
  weights.aiAccuracy += 0.025;
}

// يحفظ في Redis
await saveWeights(weights);
```

---

## 🔄 System Lifecycle

```
1. npm start
   ↓
2. app.js → initializeApp()
   ↓
3. Connect MongoDB, Redis
   ↓
4. initServices() → tripScheduler.start()
   ↓
5. Every 60s: check trips
   ↓
6. Mobile apps send locations (every 20s)
   ↓
7. processLocationUpdate() → 9 layers
   ↓
8. Notifications, escalations, learning
   ↓
9. Trip ends → clearTripState()
```

---

## 📞 API Endpoints Summary

| Method | Endpoint                            | Description                                 |
| ------ | ----------------------------------- | ------------------------------------------- |
| GET    | `/api/orders/for-guide`             | جلب الرحلات المتاحة (يدعم `filter`) 🆕      |
| GET    | `/api/orders/nearby-guides`         | جلب المرشدين القريبين (عشوائي افتراضياً) 🆕 |
| GET    | `/api/orders/order/:id/review`      | مراجعة المتقدمين (يدعم `sortBy`) 🆕         |
| POST   | `/api/trip/location`                | تحديث الموقع                                |
| POST   | `/api/trip/safety-response`         | الرد على سؤال أمان                          |
| POST   | `/api/trip/device-health`           | تحديث حالة الجهاز                           |
| POST   | `/api/trip/acknowledge-separation`  | تأكيد الابتعاد                              |
| POST   | `/api/trip/route-response`          | الرد على سؤال الانحراف عن المسار            |
| POST   | `/api/trip/check-meeting-point`     | فحص الوصول لنقطة التجمع 🆕                  |
| POST   | `/api/orders/selectOffer/:id`       | اختيار عرض مرشد لبدء الرحلة 🆕              |
| POST   | `/api/trip/request-completion`      | طلب إنهاء الرحلة 🆕                         |
| POST   | `/api/trip/cancel`                  | إلغاء الرحلة 🆕                             |
| GET    | `/api/trip/:tripId/status`          | حالة الرحلة                                 |
| GET    | `/api/trip/:tripId/progress`        | نسبة اكتمال الرحلة                          |
| GET    | `/api/trip/:tripId/payment-summary` | ملخص الدفع 🆕                               |
| GET    | `/health/live`                      | Liveness probe                              |
| GET    | `/metrics`                          | Prometheus metrics                          |

---

## 🎯 Key Features

✅ **نظام مزايدة ذكي** يتيح للمرشدين اقتراح الأسعار وخطوط السير.
✅ **إدارة تداخل (Conflicts)** تمنع الحجوزات المزدوجة للمرشدين وتعيد طلباتهم تلقائياً.
✅ **تتبع أمان فردي (Solo System)** يدعم السائحين الراغبين في الخصوصية مع أمان كامل.
✅ **تسعير مرن** يدعم رسوم الأمان ($8) والعمولات التلقائية.
✅ **15 طبقة أمان متكاملة** (Layer 1-15 في مجلد safety + Support Layer)
✅ **تحليل الأماكن الآمنة (POI)** (مطاعم، فنادق، محطات) مع توفير بدائل آمنة للمناطق الخطرة.
✅ **محرك خرائط عالمي** (Google, Baidu, Yandex, OSM, HERE) لضمان التغطية.
✅ **ML Brain متقدم** يعالج 35 خاصية ويتعلم من تاريخ الطوارئ، الشات، والتقييمات.
✅ **قواعد أمان ديناميكية 100%** تعتمد على الشمس والبحث اللحظي.
✅ **نظام ردود مرنة** تدعم الصور، المواقع، والاختيارات.
✅ **مرونة عالية** عبر Circuit Breakers و Notification Queues.
✅ **تتبع دقيق للمسارات** وكشف التوقفات المفاجئة.
✅ **تحليل الفيديو الذكي** (Layer 12) مع Youtube API و Gemini Flash.
✅ **Geo-Aware Architecture** مع دعم كامل لـ 11 لغة و 50 دولة.

### Update Log (Recent Refactoring - Phase 17 & 18)

#### 1. Global Geo-Aware System

**الملف:** `config/geoConfig.js` & `services/safety/shard/searchEngineAggregator.js`

- **التدويل (Internalization):** النظام الآن يكتشف الدولة (من 50+ دولة) ويضبط إعداداته تلقائياً.
- **Search Strategy:** يستخدم "Yandex" في روسيا، "Baidu" في الصين، و "Google/Bing" لباقي العالم.
- **Localized Danger Detection:** كلمات مفتاحية (Keywords) بلغة البلد الأصلية (مثل "حريق"، "fire", "пожар") لضمان أدق نتائج بحث، مع الحفاظ على **خصوصية المخرجات بالإنجليزية**.

#### 2. English-Only UX Overhaul

**الملف:** `services/flexibleResponseService.js` & `routeMonitor.js`

- **Strict Policy:** تم تحويل كافة الرسائل (Notifications) والأسئلة (Questions) إلى اللغة الإنجليزية حصراً.
- **Simplified Communication:** لضمان الفهم العالمي وتوحيد تجربة المستخدم في حالات الطوارئ.

#### 3. Enhanced Video Intelligence (Sari'a Sari'a)

**الملف:** `services/safety/videoRiskAnalyzer.js`

- **YouTube Data API:** تم دمج API يوتيوب الرسمي لكشف أحداث البث المباشر (Live) والأخبار العاجلة بسرعة فائقة.
- **Multimodal Analysis:** إرسال صور الـ Thumbnail إلى **Gemini 1.5 Flash** لتحليلها بصرياً (كشف الدخان، السلاح، التجمعات) بدلاً من الاعتماد على العنوان فقط.
- **Security First:** يتم تفعيل الفحص اللحظي دائماً في الدول عالية الخطورة (High-Risk Zones) دون النظر للتكلفة.

#### 4. Audit & Reliability Fixes (Phase 17)

- **Robust Timer Management:** استخدام `timerManager` المركزي لمنع تسرب الذاكرة في `routeMonitor`.
- **Predictive Sensitivity:** خفض عتبة سرعة المشي إلى 1 كم/س في `predictiveSafety.js` لاكتشاف التحركات البطيئة بدقة.

#### 6. Advanced Action Intelligence & Platform Vision (Phase 19-21) 🆕

- **Stationary Optimization:** ذكاء اصطناعي يكتشف "التوقفات الآمنة" (فنادق، مطاعم موثقة) ويخفف حدة المسح لتوفير الموارد.

#### 7. Behavioral Learning & Reliability Fixes (Phase 22-23) 🆕

**الملف:** `userProfileService.js`, `safetyOrchestrator.js`, `data_preprocessor.py`

- **Behavioral Integration:** دمج بيانات `EmergencyAlert`, `Chat`, و `Review` في ملف المستخدم ليكون الـ ML "متعلماً" لسوابق المستخدم قبل بدء الرحلة.
- **Safe Alternatives (🆕):** تطوير `findSafeAlternatives` لتقديم مقترحات لأماكن آمنة قريبة (مطاعم، مراكز تسوق) وتضمينها في تحذيرات الموقع الخطرة.
- **Notification Anti-Spam:** منع تكرار إشعارات الطوارئ إذا كان هناك بلاغ مفتوح بالفعل، مع ربط إشعارات الأمان بسياق الشات (Emergency Context).
- **Critical Fixes:** إصلاح خلل `initializeTripContext` لضمان صحة بيانات تتبع المسار، وإصلاح تكرار الدوال في `mapVerifier.js`.

# ML Brain Python Service (`mlBrainPy`)

## Overview

- There are two ML systems: JavaScript-based `mlAnalyzer.js` and Python-based `mlBrainpy` (decoupled at the root level)
- The Python ML Brain is the primary system; JS is fallback for the legacy Node.js-based ML components, providing a more robust and scalable architecture.

## Key Features

- **Multi-Output Neural Network**: Predicts risk levels and suggests safety actions (Map, AI, Escalation) simultaneously.
- **Ensemble Modeling**: Combines PyTorch Neural Networks with XGBoost for enhanced prediction reliability.
- **Explainability**: Uses SHAP values to provide human-readable reasoning for every safety decision.
- **Autonomous Decision Making**: Maturity-gated logic that empowers the system to act independently as it learns.
- **Silent Vetting**: Advanced trajectory analysis that detects if user deviations are logical (e.g., heading to a POI) before alerting.
- **Automated Training**: Integrated pipeline that fetches raw data from MongoDB and retrains models automatically.

## File Structure

- `api.py`: FastAPI endpoints and Pydantic request/response models.
- `__init__.py`: Orchestration layer (MLBrain class) providing a unified interface.
- `neural_network.py`: PyTorch implementation of the safety prediction network.
- `ensemble_model.py`: Weighted ensemble of Neural Network and XGBoost.
- `decision_engine.py`: Refines raw predictions into actionable safety proposals.
- `explainability.py`: SHAP-based model interpretability.
- `motion_trajectory_brain.py`: Advanced trajectory prediction and POI vetting.
- `trainer.py`: Automated training pipeline with balanced sampling.
- `maturity_monitor.py`: Tracks model progress from 'Infant' to 'Expert'.
- `db_connector.py`: Asynchronous MongoDB access layer.
- `config.py`: System-wide configuration for NN architecture, maturity levels, and safety thresholds.
- `admin_communicator.py`: Dispatch layer for administrator reports and anomaly alerts.
- `ml_report_builder.py`: Formatted report generation (Weekly, Health, Training).
- `alert_policy_engine.py`: Cooldown and threshold management for system alerts.
- `data_preprocessor.py`: Feature engineering and normalization logic.

## API Endpoints

- `GET /health`: Service health check.
- `GET /api/v1/status`: Comprehensive system statistics.
- `POST /api/v1/predict`: Get safety prediction for an event.
- `POST /api/v1/learn`: Submit event for online learning.
- `POST /api/v1/trajectory/analyze`: Analyze motion trajectory and deviation tolerance.
- `POST /api/v1/train/auto`: Trigger automated training from MongoDB.
- `GET /api/v1/maturity`: Current model maturity level and progress.

## Tech Stack

- **Framework**: FastAPI
- **ML Libraries**: PyTorch, XGBoost, Scikit-learn, SHAP
- **Database**: Motor (Async MongoDB)
- **Deployment**: Docker (via `./services/mlBrainPy/Dockerfile`)

---


---
