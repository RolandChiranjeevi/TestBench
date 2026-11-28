# Vision

TestBench är en AI-assisterad testmiljö där människan äger kraven och besluten, medan AI hjälper till att föreslå, förklara och förbereda.

> Människan bestämmer vad som är sant.  
> AI hjälper till att föreslå, förklara och förbereda.  
> Allt AI-genererat är tydligt märkt och förblir ett förslag tills en människa aktivt tar ansvar för det.

## Kärna

- Människan skapar och äger krav.
- AI föreslår testfall, buggar, manuella steg och automatisering.
- Människan granskar, redigerar, godkänner, avvisar eller ignorerar.
- Inget blir "sant" eller färdigt utan mänskligt beslut.
- Flera projekt kan köras parallellt utan datakorsning.
- Externa integrationer är inte kärnan just nu.

## Principer

- AI föreslår, människan bestämmer.
- Allt AI-genererat är tydligt märkt.
- Inget AI-genererat blir automatiskt godkänt.
- Människan har alltid sista ordet.
- Säkerhet och spårbarhet är grundläggande.
- Externa integrationer är valfria, inte kärnan.

## TestBench — samlingsplatsen

TestBench är en lokal app på användarens dator som samlar allt som rör test: krav, testfall, testkörningar, observationer, buggar och annan testrelaterad information.

En användare kan:

- Skapa, redigera och godkänna **krav** (manuellt, via import från Jira/Azure/dokument, eller som AI-förslag baserat på observationsluckor).
- Skapa och hantera **testfall** — både manuella och automatiserade.
- Organisera testfall i **mappar**, samla dem i **suites** (körbara grupper) som kan köras en gång eller enligt ett **schema**, och köra ett urval eller ett enskilt testfall som en **run**. Se "Suites och runs" nedan.
- Köra tester **manuellt** (användaren kör själv) eller **automatiserat** (TestPilot-agenten kör).
- Se **observationer** från körningar — avvikelser, säkerhetsproblem, tillgänglighetsproblem.
- Konvertera observationer till **buggrapporter** med beskrivning av felet och eventuell föreslagen fix.
- Se **spårbarhet**: när en körning gjordes, vad som framkom, vilka testfall som kördes, vilka som failade.
- Hantera **konton och roller** (Owner, Admin, Tester, Viewer) med rätt behörigheter.
- Be **TestPilot** om en discover, eller om en omkörning av failade automatiska testfall, direkt från UI:t. Förfrågan väntar i en kö tills en agent plockar upp den (se "Trigger från TestBench UI"); TestBench startar inget själv.

## Suites och runs

Orden "suite" och "run" betyder olika saker och ska hållas isär:

- **Mapp / organisationsstruktur — finns.**
  Ett träd av mappar (`suites`) där varje testfall ligger i en mapp. Används för att sortera och hitta testfall, med dra och släpp i testfallslistan. En mapp går inte att köra som helhet.
- **Suite som körbar grupp av testfall — finns (#91, #92).**
  Ett namngivet, sparat urval av testfall som körs som en enhet från fliken Suites under Runs (tabellen heter fortfarande `run_templates`). En suite kan innehålla både manuella och automatiserade testfall, och UI:t visar vilka som har ett automatiserat test kopplat. Körningen är en **manuell run**: TestBench startar inga automatiserade tester själv.
- **Suite på schema — finns (#93, #95).**
  En suite kan få ett schema (varje dag eller vissa veckodagar, tidszon, eller egen cron). När tiden kommer gör TestBench en manuell run märkt *Scheduled* som en människa går igenom, och ett schemalogg visar vad som hänt. Schemat kör inget automatiskt och startar inga automatiserade tester. Se [docs/suite-schedules.md](docs/suite-schedules.md).
- **Run som enskild eller vald körning — finns för manuella tester.**
  En körning av ett enskilt testfall, ett urval eller en suite, med resultat per testfall och per steg. Automatiserade runs kommer in som importerade resultat (CI, uppladdning, GitHub Actions), men TestBench startar dem inte själv.

Båda finns nu: körbara suites för stora grupper, och runs för enskilda eller valda testfall. TestBench startar fortfarande inga *automatiserade* körningar själv. En användare kan i stället be en agent om det (se Trigger från UI), och agenten kör då i användarens egen miljö.

## TestPilot — AI-agenten

TestPilot är AI-agenten som drivs från TestBench. Allt börjar med en **request** (en beställning) som användaren skapar i TestBench, och requesten är beslutet: det som kryssas i där gäller.

**Slutmålet (omskrivet 2026-11-23).** Användaren skapar en request i TestBench, väljer allt i UI:t och går. Agenten gör arbetet i användarens egen miljö och lämnar ett färdigt resultat som **förslag**, som användaren granskar en gång i TestBench. Det fungerar mot en riktig sajt i testmiljö, och resultatet går att jämföra med andra agentverktyg.

Requesten väljer:

- **Sort:** discover (läsa), discover med skrivning ("Act on target") eller belastningstest.
- **Delar:** visuell granskning, API-kontroller och säkerhetsgranskning (observationer, inga attacker).
- **Läsa eller skriva:** vid läsa tittar agenten bara, utan att klicka runt eller skicka formulär. Vid skriva får den agera på en adress som inte är produktion, med påhittad data, medan användaren loggar in själv. Alla åtgärder loggas.

Det agenten lämnar, alltid som förslag en människa godkänner:

- **Buggrapporter** enligt mallen, **observationer** (säkerhet, visuellt), **testfall** och en **testplan**.
- **Automatiserade testfall som `*.spec.ts`**, som agenten kan lägga i den git-repo användaren anger (läget av, lokalt eller pull request; aldrig merge, aldrig ny repo). Människan strukturerar sedan om, lägger till, tar bort och uppdaterar specarna där.
- **Belastningstestets resultat**, som visas på dashboarden.

Frågebudgeten är en del av designen: **två stopp** (vilken request, och en bekräftelse som återger valen), plus en separat produktionsfråga en gång per adress, och bara när agenten skriver eller lägger last. Inloggning görs av användaren en gång i början, och inga lösenord lämnas till agenten. Ett stopp avslutar den delen med en notering. En request körs i taget.

Det äldre audit-flödet (discover → plan → run → report → deliver, med manuell körning av varje steg) är **ersatt** av request-flödet och lämnas kvar bara tills det städas bort. API- och säkerhetsdelarna flyttas in under requestens fyndväg.

## Agentflödet och MCP-bryggan

Målet är att användaren konfigurerar en gång och sedan styr allt från TestBench:

1. Användaren skapar en **request-token** (`tbrq_`) en gång i TestBench, under Settings → Agent. Hela token visas bara vid skapandet, den kan återkallas och senaste användning syns.
2. Användaren konfigurerar Claude/TestPilot en gång: `TESTBENCH_URL`, `TESTBENCH_TOKEN` och projektet.
3. Användaren klickar **Request discover** i TestBench (finns).
4. Claude/TestPilot tar förfrågan via **TestBench MCP-servern** (`mcp/`, stdio).
5. TestPilot utforskar appen sida för sida via **Playwright MCP**, i användarens egen miljö.
6. Discover lämnar testfall, buggrapporter, observationer och förslag på manuella testfall i TestBench, kopplade till rätt projekt, krav och ärenden där det passar.
7. Användaren granskar. Allt agentgenererat är märkt och förblir ett förslag tills en människa bestämmer.
8. Användaren väljer testfall och ber om en körning. TestPilot tar den via MCP, kör Playwright via Playwright MCP och importerar resultatet, som länkas till testfall, specar och ärenden.

Rollerna:

- **TestBench** är källan: projekt, krav, ärenden, testfall, buggrapporter, observationer, förslag, specar, förfrågningar och resultat. TestBench startar inget, kör aldrig Playwright och skriver aldrig till disk eller git.
- **TestPilot** är agenten som fattar beslut, följer sina egna regler och bekräftelser, skapar material och kör flöden.
- **Playwright MCP** är gränssnittet mot webbappen.
- **TestBench MCP-servern** är bryggan mellan Claude/TestPilot och TestBench: fyra verktyg (hämta nästa förfrågan, avsluta eller släppa den, rapportera resultat per testfall för en run-förfrågan, rapportera en finding) över kön som redan finns.
- **Token** autentiserar agenten. En request-token kan ta, släppa och avsluta förfrågningar, och kan inte skapa eller avbryta dem, läsa krav, röra specar eller se konton. Agentens text från en förfrågan (adress, anteckning) är data, aldrig instruktion.

Det som redan är byggt är kön, Request discover i UI, request-tokens, `/testpilot-requests`, release och audit-länk, och att agenten själv lämnar in en omkörnings rapport (se backlogg T, T-A, T-B), samt MCP-bryggan över kön (backlogg AG-A, #110) och agent findings (backlogg AG-B, #111): agenten skapar testfall, buggrapporter, observationer och manuella testförslag direkt i TestBench, kopplade till den discover-förfrågan den tog. Allt landar som utkast eller förslag och godkänns aldrig automatiskt, testfallen märks som agentens, och ogranskade AI-utkast tas inte med av "Select all" när en run byggs. Det senaste steget är:

- **Run-förfrågan** (backlogg AG4): användaren väljer testfall och klickar **Ask agent to run**. TestBench skapar en manuell run med tomma resultat och en `run`-förfrågan, och runnen visas som "Waiting for agent". Testfallens text (men aldrig specar eller krav) skickas till agenten när den tar förfrågan, och agenten får inte hitta på resultat. Agenten tar förfrågan, kör testfallen i användarens miljö med Playwright MCP och rapporterar ett resultat per testfall (AG5a): en batch är allt eller inget, varje testfall rapporteras en gång, aldrig över ett resultat en människa har satt, och bara när en person har slagit på *Agent results*. Resultaten märks som agentens, en person kan ändra dem, och runnen förblir pågående tills en person granskar och avslutar den. Agenten kan också köra testfallens automatiserade tester med Playwright i användarens repo och lämna in rapporten (AG5b): den blir en egen automatiserad körning som når specarna via filnamnsmatchning och testfallen via länken, där TestBench bestämmer länken och texten i rapporten aldrig gör det, och den rör inte den manuella runnen.

Senare: skrivbordsappen (och eventuell körning i sandbox, F-B), Azure DevOps och mobilappstest.

## Viktiga komponenter

- **Playwright MCP** — central för webb-UI-testning.
- **Claude** — AI-motorn för agenten.
- **Design-review skill** — täcker WCAG 2.2 AA som en del av design-granskning; ingen separat accessibility-skill. Automatiska kontroller ger inte full konformitet.
- **API-testing skill** — för API-testning.
- **Loadtest + security-review skills** — för belastning och säkerhet.

## Säkerhet och spårbarhet

- **Target profiles** med `observe_only` (default) eller `full` (kräver explicit godkännande).
- **Agent-rules** som gemensam regelbok (observe-only default, inga hemligheter i klartext, konkreta begränsningar).
- **Audit contract / package format** för spårbarhet (manifest, executions, evidence).
- **Delivery till TestBench** (`deliveryEnabled`) — agenten kan leverera paket till TestBench.

## Testfall i spec.ts

Automatiserade testfall ska skrivas i **Playwright-format (`*.spec.ts`)**, så att de kan köras av TestPilot och underhållas som vanlig kod. Ett AI-genererat spec är ett förslag som en människa godkänner innan det körs.

## Integrationer

**Finns redan:**

- **Jira och Linear** — export av buggar.

**Framtida:**

- **Azure DevOps** — export av buggar/krav/testfall.
- **Mobilappstest** — t.ex. via Appium/Maestro (öppen källkod) eller BrowserStack (stor scope).

## Arkitektur

- **TestBench och TestPilot är sammanslagna till ett repo.** TestPilots skills ligger i `.claude/skills/` och dess verktyg under `testpilot/`. Spec.ts-stödet byggs mot den strukturen. Suite-modellen och triggern från UI är byggda.
- **TestBench är en lokal app** på användarens dator, med tillgång till internet.
- **Trigger från TestBench UI** till TestPilot är nyckel-UX. Den är byggd som en kö: användaren ber om en discover eller en omkörning av failade automatiska tester direkt i TestBench, och en agent med en request-token plockar upp förfrågan i användarens egen miljö (`/testpilot-requests`). TestBench startar ingenting själv. Agenten körs av användaren (till exempel Claude Code) och användaren betalar själv.

## Vad som redan är byggt

- Konton + roller (5a–5d).
- Requirements, test cases, runs, observations, bugs, agent proposals — kärnan finns.
- **Manuell testkörning — komplett:** runs med status, resultat per testfall och per steg, run-mallar, omkörning av misslyckade och manuella testförslag från agenten som kan bli testfall.
- **Suites som mappträd** för testfall.
- **Körbara suites och schemaläggning** (#91–#93, #95): en suite körs som en manuell run, eller på schema med ett schemalogg.
- **Trigger från UI, som en kö** (#98, #99): en tester ber en agent om en discover eller en omkörning av failade automatiska tester. En agent med en request-token (`tbrq_`) plockar upp förfrågan i användarens egen miljö, och användaren bekräftar varje stopp. TestBench startar inget själv. En omkörnings rapport kan agenten lämna in själv (#104, #105): av som standard, bara för förfrågans egna tester, en gång, och användaren bekräftar uppladdningen. En agent kan lämna tillbaka en förfrågan (släpp), och en klar discover länkar till sin audit.
- Import av automatiska testresultat (Playwright, TestCafe, Selenium, Bruno, JUnit) via CI, uppladdning och GitHub Actions.
- **Jira- och Linear-export av buggar.**
- API-testing skill (PR #10 + säkerhetsfixar).
- Loadtest + security-review skills.
- Target profiles + permission modes + agent-rules + audit contract.
- Delivery till TestBench (`deliveryEnabled`).
- WCAG 2.2 AA i design-review skillen.
- **TestBench och TestPilot i ett repo** — TestPilots historik är nåbar via `git log --follow` eller `--full-history`.

## Vad som saknas / behöver byggas

- **Användarskapade automatiserade testfall (spec.ts)** — S1 (spec från ett testfall), S2 (egna specar) och S3 (specens resultat och jämförelse med användarens repo) är byggda, se backlogg U.
- **Resultat från agenten**: run-förfrågan (AG4, #112), resultat per testfall (AG5a, #113) och Playwright-rapport som når specar och testfall (AG5b) är byggda. MCP-bryggan (AG-A, #110) och agent findings (AG-B, #111) är klara.
- **Azure DevOps-export** — framtida.
- **Mobilappstest** — framtida.

## Nästa steg

Ordningen (omskriven 2026-11-23, se även överst i `backlog.md`):

1. **Förfina discover-flödet** (först): läsande och skrivande discover mot riktiga testsajter med färre stopp, API och säkerhet via requestens fyndväg i stället för audit-flödet, och inloggningsprov. Allt hör till veckans mål, en jämförelse med andra agentverktyg.
2. **Dashboard** som slår ihop dagens med belastningstestets resultat och det en produktägare vill se. UI, så den kommer efter det tunga.
3. **Knapp i TestBench som startar git-runnern** (beslutad som A, ingen start nu): TestBench anropar repots workflow (`workflow_dispatch`), och resultatet kommer tillbaka via importen som redan finns. Det ändrar "TestBench startar inget själv", så det kräver en egen skiss, en lagrad token och ett uttryckligt ja innan bygge. Schema kan i stället ligga i workflowen själv tills dess.
4. **Integrationer (Azure DevOps, mobil)** — senare.

## Frågor att förtydliga

- **Ägande av spec.ts** — i databasen, som filer på disk eller i användarens git-repo? Hur isoleras de när de körs?
