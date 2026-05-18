# Travel Support Europe Assistance Booking

This is a local TSE-branded copy of the Apex assistance booking launcher. It was forked from the Roadsurfer version for safe local adaptation and is not connected to the Roadsurfer GitHub or Render service.

## What it does

- Displays a Travel Support Europe branded booking launcher.
- Uses the official TSE logo at `assets/tse-logo.svg`.
- Uses a local TSE site image at `assets/tse-splash.jpeg`.
- Provides multilingual landing-page support for a broad European language set.
- Uses English fallback text inside the Apex booking form for languages that do not yet have full field-by-field translations.
- Opens the Apex booking page through the local private server.
- Keeps Apex credentials in server environment variables, not browser JavaScript.

## Local run

```bash
node server.cjs
```

Then open `http://127.0.0.1:5173`.

## Apex configuration

The Apex portal host is:

```text
https://vehiclerecoveryconsultantsltd.apex-rms.com/Portal/RAndR/WelcomeRAndR.aspx
```

Set these environment variables outside the files:

```text
APEX_USERNAME
APEX_PASSWORD
WHAT3WORDS_API_KEY
```

Optional defaults for the booking form:

```text
APEX_JOB_DATE_NAME=Immediate
APEX_ACCOUNT_NAME=TRAVELSUPPORT
APEX_COMPANY_NAME=VRCR LTD
APEX_SITE_NAME=VEHICLE RECOVERY CONSULTANTS LTD
APEX_SERVICE_NAME=Vehicle Recovery
ORDER_PREFIX=TSE
SUPPORT_PHONE=+46340692578
SUPPORT_WHATSAPP_NUMBER=00441144701053
```

The support button opens WhatsApp using `SUPPORT_WHATSAPP_NUMBER`.

The Apex Order No is filled automatically with a random `ORDER_PREFIX` value and hidden from the driver. The old Auth. Code label is shown to drivers as `TSE Case No.`.

## Hidden UK mirror

The driver-facing form uses the Europe Apex portal. On Send, the server also mirrors the submitted booking into the UK Apex portal in the background:

```text
MIRROR_APEX_HOST=vrcr.apex-rms.com
MIRROR_APEX_USERNAME=
MIRROR_APEX_PASSWORD=
MIRROR_APEX_JOB_DATE_NAME=Immediate
MIRROR_APEX_ACCOUNT_NAME=TRAVEL SUPPORT
MIRROR_APEX_COMPANY_NAME=VRCR LTD
MIRROR_APEX_SITE_NAME=VRCR LTD
MIRROR_APEX_SERVICE_NAME=Vehicle Recovery
MIRROR_APEX_ODOMETER=1
```

If the mirror username/password are not set, the app reuses `APEX_USERNAME` and `APEX_PASSWORD`.
