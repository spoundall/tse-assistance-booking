# Travel Support Europe local handover

This folder is the local TSE adaptation of the assistance booking app:

`C:\Users\steve\Documents\Codex\tse`

It is intentionally separate from the Roadsurfer source folder, GitHub repository, and Render service.

## Current status

- Front page is rebranded for Travel Support Europe.
- Local assets include `assets/tse-logo.svg`, `assets/tse-icon.png`, and `assets/tse-splash.jpeg`.
- CSS colours follow the TSE website palette: dark blue `#223141`, royal blue `#293cac`, and cyan `#45cdf7`.
- Main app copy focuses on 24/7 roadside assistance across Europe.
- The landing page supports a broad European language set.
- The deeper Apex booking form has full dictionaries for the original languages and falls back to English for newly added languages until full translations are added.
- Booking route still points to the Apex recovery booking form through the local server.
- Apex host is `vehiclerecoveryconsultantsltd.apex-rms.com`.
- Apex job date default is `Immediate`.
- Apex account default is configurable with `APEX_ACCOUNT_NAME`, defaulting to `TRAVELSUPPORT`.
- Apex site default is `VEHICLE RECOVERY CONSULTANTS LTD`.
- Apex service default is `Vehicle Recovery`, and the Service row is hidden from drivers.
- Order No is auto-filled with a random `TSE...` reference and hidden from drivers.
- Auth. Code remains visible but is relabelled as `TSE Case No.`.
- The floating support button opens WhatsApp using `SUPPORT_WHATSAPP_NUMBER`, currently `00441144701053`.
- Hidden UK mirror is enabled by default and points to `vrcr.apex-rms.com`.
- Hidden UK mirror defaults to job date `Immediate`, account `TRAVEL SUPPORT`, company `VRCR LTD`, site `VRCR LTD`, and odometer `1` when the driver leaves odometer blank.
- On Send, the visible Europe booking is submitted first, then the server mirrors the same form values to the UK Apex portal in the background.
- The driver sees a simple Sent page after the submit flow rather than UK mirror details.

## Private environment variables

Do not put these values into files:

- `APEX_USERNAME`
- `APEX_PASSWORD`
- `WHAT3WORDS_API_KEY`

Optional:

- `APEX_JOB_DATE_NAME`
- `APEX_ACCOUNT_NAME`
- `APEX_COMPANY_NAME`
- `APEX_SITE_NAME`
- `APEX_SERVICE_NAME`
- `ORDER_PREFIX`
- `SUPPORT_PHONE`
- `SUPPORT_WHATSAPP_NUMBER`
- `MIRROR_APEX_HOST`
- `MIRROR_APEX_USERNAME`
- `MIRROR_APEX_PASSWORD`
- `MIRROR_APEX_JOB_DATE_NAME`
- `MIRROR_APEX_ACCOUNT_NAME`
- `MIRROR_APEX_COMPANY_NAME`
- `MIRROR_APEX_SITE_NAME`
- `MIRROR_APEX_SERVICE_NAME`
- `MIRROR_APEX_ODOMETER`
- `MIRROR_APEX_ENABLED`

## Local run

```powershell
cd C:\Users\steve\Documents\Codex\tse
node server.cjs
```

Local URL:

http://127.0.0.1:5173

If another copy is already using port 5173, run on another port:

```powershell
$env:PORT="5174"; node server.cjs
```
