# Stride: מאמן ריצה AI (PWA)

אפליקציית PWA בעברית, מותאמת קודם כל למובייל. היא מושכת ריצות מ-Garmin Connect, מעריכה כושר לפי המחקר של ג'ק דניאלס (VDOT), ובונה אימון יומי מותאם בעזרת Google Gemini. האפליקציה תומכת בכמה משתמשים, וכל משתמש מחבר את חשבון ה-Garmin שלו.

## איך זה עובד

```
טלפון/דפדפן ──► GitHub Pages (web/)
                   │
                   ▼
              Supabase ── Auth, Postgres + RLS, Vault (סיסמאות Garmin מוצפנות)
                   │
     ┌─────────────┴──────────────┐
     ▼                            ▼
Edge Function: recalibrate-plan    GitHub Actions: garmin-sync.yml (כל 30 דק')
  ├─ science.ts  → VDOT, אזורי קצב, פריודיזציה     └─ sync_all.py → python-garminconnect
  └─ gemini.ts   → בניית השבוע (JSON Schema) + אכיפת הקצבים
```

**העיקרון: המדע קובע את המספרים, Gemini רק משבץ אותם לשבוע.**
- **`science.ts`** (קוד דטרמיניסטי) מחשב:
  - VDOT לפי נוסחאות Daniels-Gilbert, עם הערכה לפי דופק לפי Swain.
  - אזורי קצב E/M/T/I/R.
  - תחזיות זמן למרוצים.
  - שלב באימונים (בסיס ← בנייה ← ספציפי ← טייפר).
  - יעד נפח שבועי (עד 10% עלייה, מחזור 3:1).
  - תקרות לנפח האיכות (T עד 10%, I עד 8%, R עד 5% מהנפח השבועי).
  - ACWR.
- **Gemini** בוחר את מבנה השבוע ואת ההסברים.
- **השרת אוכף** את הקצבים המדעיים על כל אימון.

## מבנה התיקיות

```
Runner/
├── web/                                   # React + TS + Vite + Tailwind v4 + PWA
│   └── src/
│       ├── lib/science.ts                 # מנוע מדעי (זהה ל-supabase/functions/_shared/science.ts)
│       ├── lib/api.ts                     # שכבת נתונים (Supabase / מצב הדגמה)
│       ├── components/                    # Layout, BottomNav, ui
│       └── views/                         # Today, History, Plan, Goals, Settings, Login
├── supabase/
│   ├── migrations/                        # סכמה, RLS, Vault RPCs
│   └── functions/
│       ├── _shared/{science,gemini,cors}.ts
│       └── recalibrate-plan/index.ts
├── garmin-sync/
│   ├── sync.py                            # ליבה + CLI מקומי למשתמש יחיד
│   ├── sync_all.py                        # סנכרון ענן לכל המשתמשים (Vault)
│   └── server.py                          # אופציונלי: שרת מקומי
└── .github/workflows/
    ├── garmin-sync.yml                    # סנכרון Garmin כל 30 דק'
    └── pages.yml                          # פריסת האפליקציה ל-GitHub Pages
```

## פיתוח מקומי

```bash
cd web
npm install
npm run dev                  # מחובר ל-Supabase (לפי web/.env)
npm run dev -- --mode demo   # מצב הדגמה עם נתוני דוגמה
```

## הגדרות ב-GitHub (Settings ← Secrets and variables ← Actions)

| סוג | שם | ערך |
|---|---|---|
| Variable | `VITE_SUPABASE_URL` | כתובת הפרויקט |
| Variable | `VITE_SUPABASE_ANON_KEY` | ה-publishable key |
| Secret | `SUPABASE_URL` | כתובת הפרויקט |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` | ה-secret key של Supabase, **לעולם לא בקוד** |

## הוספת משתמש חדש
1. פותחים את כתובת האתר ולוחצים **"משתמש חדש? יצירת חשבון"**.
2. במסך **הגדרות**:
   - מחברים את Garmin. הסיסמה נשמרת מוצפנת ב-Vault.
   - מזינים מפתח Gemini. אפשר לוותר על זה אם הוגדר `GEMINI_API_KEY` גלובלי ב-Supabase.
3. במסך **יעדים** מוסיפים מרוצים.
4. במסך **היום** לוחצים **"כיול מחדש"**.

## הערות
- `python-garminconnect` היא ספרייה לא רשמית.
- חשבון Garmin עם אימות דו-שלבי (MFA) לא יסתנכרן אוטומטית.
- Garmin עלולים לחסום מדי פעם התחברות משרתי ענן. כשזה קורה, האפליקציה מציגה את הסטטוס במסך ההגדרות.
