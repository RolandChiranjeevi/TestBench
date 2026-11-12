# Backlog

Produktfokuserad backlog. Operativa sidospår (lokala modeller, namn, domän) hör inte hit.

## Nästa

### D1: Automatiseringsförslag för planposter
**Status: klart** (mergad i #70)
- Regelbaserade förslag från godkända planposter.
- Innehåll: steg, assertions, testdata, plan.
- Människan granskar, redigerar, godkänner, avvisar eller ignorerar.
- Apply skapar alltid draft, aldrig approved.
- Ingen modell, inget nätverk, ingen extern integration.

### D2: Automatiseringsförslag för krav
**Status: klart** (mergad i #75)
- Samma mekanism som D1, men för godkända krav.
- Återanvänder D1:s mönster.

### E1: Spec-förslag för planposter
**Status: klart** (mergad i #78)
- Playwright-spec från godkänd planpost, fast mall med test.fixme, utan påhittade selektorer eller URL:er.
- Texten kan redigeras och ändringarna syns i historiken. Apply registrerar vem som applicerade; först därefter kan filen laddas ner.

### E2: Spec-förslag för krav
**Status: klart** (mergad i #80)
- Samma mekanism som E1, men för godkända krav. Filnamn req-<nummer>-<titel>.spec.ts; radering av ett krav tar bort dess spec-förslag.

### E: gemensamma regler för E1 och E2
**Status: klart** (E1 och E2 är mergade)
- Från godkända krav och planposter, föreslå Playwright-spec-filer.
- Samma ägarskapsmodell som D1 och D2.
- Förslaget är draft. Människan granskar, redigerar, godkänner, avvisar eller ignorerar.
- Apply skapar en draft-spec, aldrig en färdig eller körd.
- Ingen körning, ingen extern AI, ingen integration.
- Ingen kodgenerering utan mänskligt beslut.

### G: Buggrapport från skärmdump
**Status: klart** (mergad i #83)
- Testaren bifogar en skärmdump och en kort notis. En fast regel (ingen modell, inget nätverk) gör ett draft-bugförslag: titel från notisens första rad, steg som TODO-skelett, expected/actual som TODO.
- Skärmdumpen sparas som bevis och analyseras aldrig. Den verifieras via sin riktiga header (png/jpg/webp/gif, max 5 MB) och visas bara via egen route (attachment, nosniff, endast inloggade medlemmar).
- Samma ägarskapsmodell som D/E. Apply skapar en bugg som förblir proposed (källa manual, ursprung $screenshot, SCR-n), en gång per draft, och accepterar den aldrig.

### F-A: Kör specen själv ("Run it yourself")
**Status: klart** (mergad i #85)
- Efter Apply visar spec-kortet en ruta: TestBench kör inget. Rutan ger exakt kommando (`npx playwright test <fil>`), var filen ska ligga (`testDir`), hur appen under test pekas ut (`baseURL` i Playwright-configen) och hur resultatet kommer tillbaka (Import-sidan: Playwright JSON, JUnit XML eller zip; CI kan skicka resultat).
- "Runnable" visas bara när `test.fixme` är borttaget, annars en varning. En notis visar hur många TODO-rader som finns kvar. Rutan säger "TestBench has not checked it" och påstår aldrig att testet är korrekt.
- Ingen exekvering, ingen sandbox, ingen ny route, inga nya tabeller.

### F-B: Kör specen i TestBench (sandbox)
**Status: väntar** (görs bara om det verkligen behövs; kräver en egen, godkänd säkerhetsplan först)
- En spec är kod som en människa har redigerat. Att köra den på servern ger vem som helst med rollen tester möjlighet att köra kod på maskinen som håller all data. Node ensam kan inte begränsa nätverk eller filer: det kräver container eller OS-sandbox.
- Villkor att besluta om innan någon kod skrivs: endast admin och en inställning som är av som standard, bekräftelse per körning med exakt kommando och filens hash, loopback-mål, tom miljö utan hemligheter, tidsgräns och storleksgräns på utdata, kill switch, revisionslogg, ingen scheduler och ingen väg för AI eller token att starta en körning.
- Passar bättre efter den lokala skrivbordsappen.

## Backlog

### Bug screenshot → AI-förslag (AI-delen)
G är klart som regelbaserad första version. Det som återstår:
- AI tittar på skärmdumpen och föreslår titel, steg, förväntat/aktuellt beteende, rotorsak, ändring.
- Kräver riktig modell och prompt injection-skydd (se Säkerhet och AI).
- Människan granskar och beslutar. Godkänt förslag blir draft, aldrig automatiskt färdig bugg.
- Ingen kodgenerering, testkörning eller extern integration i första versionen.

### Release-check skill
- Egen checklista innan release.
- Krav, tester, buggar, gaps, release notes, risk.
- Producerar granskningsrapport, blockerar inte release automatiskt.

### Projektöversikt
- Översikt över projekt, audits, status, öppna gaps.

### Reviewer-fält
- Tydligare granskningsroll.

### Beslutslogg
- Mer strukturerad beslutsspår.

### Fler audit-vyer
- Fler vyer över audit-data.

### Statusfilter för gaps
- Samma filter som planposter.

### Indikator för dolda avvisade
- Tydligare indikering i kravvyn.

### Buddy-animation vid discover/run
UI/UX.
- När användaren trycker på “Discover” eller “Run” visas Buddy (handyman-maskoten) som en del av “systemet tänker/arbetar”-animationen.
- Buddy visas med enkel animation (t.ex. puls, tänkande, spinner) medan discover/run pågår.
- Animationen är kosmetisk och påverkar inte logik eller tester.
- Ingen ny data, ingen ny route, ingen integration.
- Kontrast/layout körs opt-in vid visuell ändring.

### Lokal app (desktop)
Separat fas, inte en del av D.
- Gör om TestBench till en lokal skrivbordsapp.
- Behåll webb-tekniken (samma React-gränssnitt och Fastify-server). Paketera med Electron eller Tauri; valet är öppet.
- Data lagras lokalt och ingen hosting krävs.
- Databasen är redan SQLite (`better-sqlite3`) i en lokal fil (`TESTBENCH_DATA`). För appen gäller att lägga filen i användarens datamapp, med backup och migrering.
- Bygg installatör för macOS och Windows.

## Säkerhet och AI

### Prompt injection
- Relevant när riktig AI läser externa eller användarinskickade texter.
- AI får aldrig bestämma, godkänna, köra eller ändra något.
- AI får bara föreslå.
- All inmatning behandlas som data, aldrig som instruktion.
- Alla AI-förslag är draft och kräver mänskligt beslut.
- Ingen AI-funktion får mer behörighet än användaren.
- Verktyg med side effects kräver alltid explicit bekräftelse.

### AI-agent väg
- Riktig agent kan skicka förslag via propose-token.
- Förberedd i datamodell, ej aktiverad.

### Kodgenerering
- AI föreslår kod.
- Ej påbörjad.

### Testkörning
- AI kör tester.
- Ej påbörjad.

### Extern AI-integration
- Modell bakom förslag.
- Ej påbörjad.

## Integrationer

Medvetet skjutna upp:

- Jira
- Azure DevOps
- Confluence
- GitHub Issues
- Linear
- Dokumentimport (Word, Markdown, Confluence)

## TestPilot

### Kärna
- Mergad.

### Kvar
- Schema-subset-gränser.
- Limitsräkning.
- Deliver-test.
- Riktigt API-test mot produktionsmiljö.
