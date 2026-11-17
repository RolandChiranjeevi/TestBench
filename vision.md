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

TestPilot är AI-agenten som drivs från TestBench och arbetar enligt flödet:

**discover → plan → run → report → deliver**

- **Discover:** utforskar en sida/app och föreslår testfall (både automatiserade och manuella för människan) inom agentens skill.
- **Plan:** skapar en testplan med omfattning, begränsningar och stoppvillkor.
- **Run:** kör de automatiserade testfallen.
- **Report:** skapar observationer för avvikelser, säkerhetsproblem, tillgänglighetsproblem, och föreslår buggar vid behov.
- **Deliver:** levererar resultatet tillbaka till TestBench.

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
- **Mobilappstest** — t.ex. via BrowserStack eller liknande (stor scope).

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

- **Användarskapade automatiserade testfall (spec.ts)** — S1 (spec från ett testfall) är byggd; egna specar (S2) och koppling till resultat (S3) återstår, se backlogg U.
- **Azure DevOps-export** — framtida.
- **Mobilappstest** — framtida.

## Nästa steg

1. **Användarskapade automatiserade testfall (spec.ts)** — S2 (egna specar) och S3 (koppling till resultat), se backlogg U.
2. **Integrationer (Azure DevOps, mobil)** — senare.

## Frågor att förtydliga

- **Ägande av spec.ts** — i databasen, som filer på disk eller i användarens git-repo? Hur isoleras de när de körs?
