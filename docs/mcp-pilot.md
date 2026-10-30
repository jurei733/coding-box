# MCP-Pilot: Testcenter-Import und Autokodierung

Diese Erweiterung ergänzt vier authentifizierte REST-Routen für den gemeinsamen IQB-MCP-Server. Sie basiert auf Coding-Box `474dd5125f9962e4b4d8b60b3f23c0f5637bda9d` (develop, Paketversion 1.17.5). Ein unverändertes veröffentlichtes Coding-Box-Image enthält diese Ergänzung noch nicht.

## Installation

1. Patch in einen Checkout des genannten Stands übernehmen. Für andere Releases zunächst Änderungen an Authentifizierung, Workspace-Modulen, Import und Queue-Diensten abgleichen.
2. Backend **und Liquibase-Image** aus dem gepatchten Stand bauen. `latest` aus einer Registry ersetzt diesen Schritt nicht. Den vorhandenen Build-/Deploymentweg der Installation verwenden; lokal stehen `make dev-build`, `make dev-db-validate-changelog`, `make dev-db-update` und `make dev-up` zur Verfügung. Diese Befehle verwenden die lokale `.env.dev` und eine vorhandene Docker-Umgebung.
3. Liquibase mit dem aktualisierten Root-Changelog ausführen, bevor das neue Backend startet. Neuer Changeset: `iqb:mcp-pilot-operations`. TypeORM bleibt auf `synchronize: false`.
4. Folgende Variablen für API und alle Worker setzen, die `mcp-pilot` ausführen. Die mitgelieferten Compose-Dateien reichen sie an das API-Backend weiter:

```dotenv
MCP_PILOT_ENABLED=true
MCP_PILOT_CREDENTIAL_KEY=<32-zufaellige-Bytes-in-Base64>
MCP_PILOT_TESTCENTERS='{"pilot-testcenter":{"url":"https://testcenter.example.org","workspace_ids":[42]}}'
MCP_PILOT_ALLOW_LOCAL_HTTP=false
```

Schlüssel einmal lokal erzeugen und in der Secret-Konfiguration speichern:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Alle beteiligten Prozesse verwenden denselben Schlüssel. Ein Schlüsselwechsel während wartender Importe verhindert deren Entschlüsselung. Die Testcenter-URL endet **vor `/api`**. Quell-ID und freigegebene Quell-Workspace-ID müssen zum MCP-Server passen. HTTPS-Zertifikate werden geprüft; für eine interne CA `NODE_EXTRA_CA_CERTS` in den betreffenden Node-Prozessen verwenden. Nur für lokale Entwicklung kann explizit HTTP auf Loopback freigegeben werden. Redirects werden bei Pilot-Importen nicht verfolgt.

Der neue Bull-Prozessor heißt `mcp-pilot`; die vorhandene Autokodierung läuft auf `test-person-coding`. Im Standardprofil sind beide aktiv. Bei explizitem `JOB_QUEUE_PROCESSORS` beide Prozessoren auf geeigneten Workern aktivieren. Der Export benötigt weiterhin den bestehenden `data-export`-Worker. Der MCP-Worker wartet auf den Kodierjob, deshalb dürfen dessen Prozessoren nicht fehlen. Redis-Prefix und Datenbank müssen über API und Worker übereinstimmen.

## HTTP-Vertrag

Alle Pfade haben das Präfix `/api/admin/workspace/:workspace_id` und verwenden die vorhandene Coding-Box-Sitzung als `Authorization: Bearer …`. Erforderlich: vorhandene Workspace-Berechtigung mit Zugriffsstufe mindestens 3 (Studienleitung) oder Administrator. Der Eigentümer wird aus dem geprüften Token ermittelt. Ein Status ist nur für denselben Eigentümer, Workspace und Auftragstyp lesbar; auch Administratoren erhalten keine fremden Vorgänge über diese Routen.

| Methode | Pfad | Ergebnis |
|---|---|---|
| POST | `/testcenter-imports` | 202, dauerhafte `import_run_id` |
| GET | `/testcenter-imports/:import_run_id` | Status, Fortschritt, Importstatistik |
| POST | `/autocoding-runs` | 202, dauerhafte `run_id` |
| GET | `/autocoding-runs/:run_id` | Status, Fortschritt, Kodierstatistik |

Importbody:

```json
{
  "server_id": "pilot-testcenter",
  "tc_workspace_id": 42,
  "groups": ["PILOT01_group"],
  "options": {
    "definitions": true,
    "responses": true,
    "player": true,
    "units": true,
    "codings": true,
    "booklets": true,
    "testTakers": true,
    "metadata": true,
    "logs": false
  },
  "response_overwrite_mode": "skip",
  "request_key": "pilot-001:import"
}
```

Die Testcenter-Sitzung wird ausschließlich im Header `X-IQB-Testcenter-Token` übertragen. Header aus Proxy-, Application- und Trace-Logs ausschließen. Sie wird für die Warteschlange per AES-256-GCM verschlüsselt in PostgreSQL hinterlegt, an Auftrag/Eigentümer/Quelle gebunden und vor dem ersten Quellaufruf entfernt. In Bull liegen keine Zugangsdaten. Die Sitzung muss innerhalb von zehn Minuten beansprucht werden; abgelaufene Werte werden bei Worker-Ausführung oder Statusabfrage verworfen. Das ist eine Gültigkeitsprüfung, kein zeitgesteuerter physischer Löschdienst. Normale Datenbankabfragen selektieren die Credential-Spalte nicht.

Nur die dokumentierten Optionsschlüssel sind erlaubt. Nicht angegebene Optionen entsprechen den Defaults im Beispiel; `options: {}` ist möglich. Antworten/Logs werden nach Gruppen gefiltert. Die zugehörige bestehende Fachlogik kann ausgewählte Dateitypen des **gesamten Quell-Workspaces** importieren. `skip` bezieht sich auf Antworten; dies ist keine allgemeine Zusicherung für unveränderte vorhandene Dateien. Für den ersten Pilot einen separaten leeren Zielbereich verwenden.

Kodierbody:

```json
{
  "auto_coder_run": 1,
  "groups": ["PILOT01_group"],
  "request_key": "pilot-001:coding"
}
```

Der REST-Endpunkt erlaubt weggelassene Gruppen für alle berücksichtigten Personen (`consider=true`) im Workspace. Der MCP-Live-Adapter verlangt explizite Gruppen. Numerische Gruppennamen werden zuerst zu Personen im Zielbereich aufgelöst und gelangen nicht als vermeintliche Personen-IDs in die bestehende Kodierlogik. Readiness-, Abhängigkeits- und Laufprüfungen der Coding-Box bleiben wirksam. Es wird der vorhandene regelbasierte Kodiermotor verwendet.

Eine Statusantwort sieht beispielsweise so aus:

```json
{
  "operation_id": "52d394d4-5c59-48ba-a0a8-d54075330f28",
  "run_id": "52d394d4-5c59-48ba-a0a8-d54075330f28",
  "status": "succeeded",
  "progress": 100,
  "statistics": { "totalResponses": 30, "statusCounts": {}, "result_version": "v1" }
}
```

`v1` bezeichnet die bestehende Coding-Box-Kodierversion für Lauf 1. Importstatistiken enthalten `persons`, `booklets`, `units`, `test_files`, `import_tasks`, `warning_count`, `error_count`. **`import_tasks` ist keine Antwortanzahl.** Fehlerantworten enthalten nur allgemeine Fehlercodes und Hinweise; Rohantworten und Quelltoken gehören nicht in den Status.

## Wiederholungen und Unterbrechungen

`request_key` ist je Eigentümer, Zielbereich und Auftragstyp dauerhaft eindeutig. Derselbe Schlüssel mit demselben normalisierten Body liefert denselben Vorgang. Ein veränderter Body ergibt 409 `REQUEST_KEY_CONFLICT`. Parallel ist ein aktiver MCP-Vorgang je Zielbereich erlaubt; ein anderer Start ergibt 409 `WORKSPACE_OPERATION_ACTIVE`. Auch bei verloren gegangener Startantwort immer denselben Schlüssel verwenden.

Zustände: `queued`, `running`, `succeeded`, `failed`, `needs_attention`. Teilerfolge und unklare Wirkungen enden mit `needs_attention`. Ein Bull-Redelivery wiederholt eine bereits beanspruchte Mutation nicht. Die Import-ID entspricht der vorhandenen dauerhaften Import-Run-ID; Statusabfragen können deren Ergebnis nach einer Worker-Unterbrechung übernehmen. Kodierstatus wird mit dem bestehenden Kindjob abgeglichen. Ist der Ausgang nicht belegbar, bleibt eine manuelle Prüfung erforderlich. Terminale Vorgänge werden nicht erneut gestartet; ein neuer Request-Key ist ein **neuer fachlicher Auftrag**, kein unbedenklicher Retry.

Wenn Queue-Aufträge fehlen oder ein Prozess stoppt, den Status abfragen, native Import-/Kodieransichten und Zielbestand prüfen. Während des ersten Pilots keine parallelen Änderungen über die Oberfläche ausführen. Die zusätzliche Sperre koordiniert MCP-Vorgänge; bestehende UI- und Fachsperren gelten weiterhin. Ein abgeschlossener Status beweist noch keine fachlich richtigen Sollcodes.

Aufbewahrung: Vorgänge/Idempotenzschlüssel bleiben bis zur expliziten administrativen Bereinigung bestehen; Workspace-/Benutzerlöschung kaskadiert. Automatisches Bereinigen oder manuelles Wiederfreigeben eines unklaren Auftrags ist kein neuer API-Endpunkt dieses Pilots.

## Pilot über den gemeinsamen MCP-Server

Den mitgelieferten MCP-Server v0.2.0 verwenden. In dessen `.env` die Anwendungs-Sitzungen, API-URLs **mit `/api`**, Workspace-Listen und Studio-Version setzen. Danach:

```dotenv
IQB_MODE=live
IQB_DATA_DIR=.iqb-live-pilot-001
IQB_LIVE_WRITES=true
IQB_CODING_BRIDGE=true
CODING_SERVER_ID=pilot-testcenter
PILOT_TC_WORKSPACE_ID=42
PILOT_CODING_WORKSPACE_ID=17
PILOT_GROUP_IDS=PILOT01_group
PILOT_REQUEST_KEY=pilot-001
PILOT_EXPECTED_RESPONSES=30
PILOT_TIMEOUT_SECONDS=300
```

```sh
pnpm install --frozen-lockfile
pnpm live:pilot
```

Der Lauf verwendet einen echten MCP-Client und prüft Import → Status → gruppenbegrenzte Autokodierung → erwartete verarbeitete Antwortanzahl → Exportjob → Datei. Er schreibt den Export als lokales Artefakt. Testcenter muss die abgeschlossenen Pilotantworten bereits enthalten; reale Player, Units und Kodierschemata müssen kompatibel sein. Die synthetischen Demo-Dateien des MCP-Grundgerüsts ersetzen diese Vorbereitung nicht. Für den ersten fachlichen Abgleich zehn abgeschlossene Personen × drei bekannte Variablen und eine unabhängig geprüfte Solltabelle verwenden. Alle 30 Codes/Scores im Export vergleichen; der Automatiklauf prüft zunächst nur Vertragsverhalten und Umfang.

## Entwicklung und Prüfung

Coding-Box verwendet Node 22.12 bis kleiner 23; der separate MCP-Server benötigt Node 24 oder neuer.

```sh
npm ci
npx nx lint backend
npx nx test backend --runInBand
npx nx run backend:typecheck
npx nx build backend --configuration=production
```

Die neuen Jest-Tests prüfen HTTP-Verträge, Guard-Metadaten, erneute Rechteprüfung, Eigentum, Idempotenz, konkurrierende Registrierung, Teilerfolge, Token-Löschung, persistierte Ergebnisse und numerische Gruppennamen. Echte PostgreSQL-Constraint-Tests sind separat aktivierbar. Sie benötigen eine **eigene Testdatenbank mit angewandten Liquibase-Migrationen**; die Tests erzeugen und entfernen Test-Workspace und Testnutzer:

```sh
POSTGRES_INTEGRATION_TESTS=true npx nx test backend --runInBand --testPathPatterns=mcp-pilot-operation.postgres
```

Verbindungswerte kommen aus `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. Redis- und Testcenter-Aufrufe sind in den gewöhnlichen Jest-Tests simuliert. Der Nachweis gegen echte PostgreSQL-/Redis-/Testcenter-Installationen und die Liquibase-Ausführung muss in der Zielumgebung erfolgen.
