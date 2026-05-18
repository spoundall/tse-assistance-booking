const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URLSearchParams } = require("url");

const root = __dirname;
const port = Number(process.env.PORT || (process.env.RENDER ? 10000 : 5173));
const host = process.env.HOST || "0.0.0.0";
const apexHost = "vehiclerecoveryconsultantsltd.apex-rms.com";
const mirrorApexHost = process.env.MIRROR_APEX_HOST || "vrcr.apex-rms.com";
const mirrorApexEnabled = process.env.MIRROR_APEX_ENABLED !== "false";
const apexUsername = process.env.APEX_USERNAME;
const apexPassword = process.env.APEX_PASSWORD;
const mirrorApexUsername = process.env.MIRROR_APEX_USERNAME || apexUsername;
const mirrorApexPassword = process.env.MIRROR_APEX_PASSWORD || apexPassword;
const defaultJobDateName = process.env.APEX_JOB_DATE_NAME || "Immediate";
const defaultAccountName = process.env.APEX_ACCOUNT_NAME || "TRAVELSUPPORT";
const defaultCompanyName = process.env.APEX_COMPANY_NAME || "VRCR LTD";
const defaultSiteName = process.env.APEX_SITE_NAME || "VEHICLE RECOVERY CONSULTANTS LTD";
const defaultServiceName = process.env.APEX_SERVICE_NAME || "Vehicle Recovery";
const defaultMirrorOdometerValue = process.env.MIRROR_APEX_ODOMETER || "1";
const defaultOrderPrefix = process.env.ORDER_PREFIX || "TSE";
const supportPhone = process.env.SUPPORT_PHONE || "+46340692578";
const supportWhatsappNumber = process.env.SUPPORT_WHATSAPP_NUMBER || "00441144701053";
const what3wordsApiKey = process.env.WHAT3WORDS_API_KEY || process.env.W3W_API_KEY;
const bookingPath = "/Portal/RAndR/Popups/JobDetails.aspx?jobid=null";
const cookieJar = new Map();
const mirrorCookieJar = new Map();
const primaryApex = {
  host: apexHost,
  username: apexUsername,
  password: apexPassword,
  cookieJar,
  jobDateName: defaultJobDateName,
  accountName: defaultAccountName,
  companyName: defaultCompanyName,
  siteName: defaultSiteName,
  serviceName: defaultServiceName,
};
const mirrorApex = {
  host: mirrorApexHost,
  username: mirrorApexUsername,
  password: mirrorApexPassword,
  cookieJar: mirrorCookieJar,
  jobDateName: process.env.MIRROR_APEX_JOB_DATE_NAME || defaultJobDateName,
  accountName: process.env.MIRROR_APEX_ACCOUNT_NAME || "TRAVEL SUPPORT",
  companyName: process.env.MIRROR_APEX_COMPANY_NAME || "VRCR LTD",
  siteName: process.env.MIRROR_APEX_SITE_NAME || "VRCR LTD",
  serviceName: process.env.MIRROR_APEX_SERVICE_NAME || defaultServiceName,
  odometerValue: defaultMirrorOdometerValue,
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("ok");
      return;
    }

    if (request.url.startsWith("/api/what3words")) {
      await handleWhat3Words(request, response);
      return;
    }

    if (request.url === "/book-recovery") {
      await ensureApexLogin(primaryApex);
      response.writeHead(302, { Location: `/apex${bookingPath}` });
      response.end();
      return;
    }

    if (request.url.startsWith("/apex/")) {
      await proxyApex(request, response);
      return;
    }

    serveStatic(request, response);
  } catch (error) {
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Could not open the assistance booking screen. ${error.message}`);
  }
});

function serveStatic(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(root, requestedPath);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(data);
  });
}

async function handleWhat3Words(request, response) {
  const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);
  const lat = Number(requestUrl.searchParams.get("lat"));
  const lng = Number(requestUrl.searchParams.get("lng"));
  const language = normaliseWhat3WordsLanguage(requestUrl.searchParams.get("language"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    sendJson(response, 400, { error: "Location was not available from the phone." });
    return;
  }

  if (!what3wordsApiKey) {
    sendJson(response, 503, {
      error: "what3words is not configured yet.",
      coordinates: { lat, lng },
    });
    return;
  }

  const w3wUrl = new URL("https://api.what3words.com/v3/convert-to-3wa");
  w3wUrl.searchParams.set("key", what3wordsApiKey);
  w3wUrl.searchParams.set("coordinates", `${lat},${lng}`);
  w3wUrl.searchParams.set("language", language);
  w3wUrl.searchParams.set("format", "json");

  const apiResponse = await requestJson(w3wUrl);
  if (apiResponse.statusCode >= 400 || apiResponse.body.error) {
    sendJson(response, apiResponse.statusCode >= 400 ? apiResponse.statusCode : 502, {
      error: apiResponse.body.error?.message || "Could not get a what3words location.",
    });
    return;
  }

  sendJson(response, 200, {
    words: apiResponse.body.words,
    map: apiResponse.body.map,
    nearestPlace: apiResponse.body.nearestPlace,
    language: apiResponse.body.language,
    coordinates: apiResponse.body.coordinates || { lat, lng },
  });
}

async function proxyApex(request, response) {
  await ensureApexLogin(primaryApex);

  const localUrl = new URL(request.url, `http://127.0.0.1:${port}`);
  const apexPath = localUrl.pathname.replace(/^\/apex/, "") + localUrl.search;
  const body = await readBody(request);
  const postedForm = parsePostedForm(request.headers, body);
  const mirrorSubmit = shouldMirrorBookingSubmit(request.method, apexPath, postedForm);
  const apexResponse =
    request.method === "GET" && apexPath === bookingPath
      ? await requestBookingPageWithConfiguredAccount(primaryApex)
      : await requestApex(request.method, apexPath, request.headers, body, primaryApex);

  if (mirrorSubmit && apexResponse.statusCode < 400) {
    let mirrorStatus = "sent";
    try {
      const mirrorResponse = await mirrorBookingSubmission(postedForm);
      mirrorStatus = `${mirrorResponse.statusCode}`;
    } catch (error) {
      mirrorStatus = "failed";
      console.error(`Hidden UK mirror submit failed: ${error.message}`);
    }

    sendSentPage(response, mirrorStatus);
    return;
  }

  if (apexResponse.statusCode >= 300 && apexResponse.statusCode < 400 && apexResponse.headers.location) {
    response.writeHead(apexResponse.statusCode, {
      Location: rewriteLocation(apexResponse.headers.location),
    });
    response.end();
    return;
  }

  const contentType = apexResponse.headers["content-type"] || "application/octet-stream";
  let payload = apexResponse.body;

  if (contentType.includes("text/html")) {
    payload = Buffer.from(rewriteHtml(payload.toString("utf8")), "utf8");
  } else if (contentType.includes("text/css")) {
    payload = Buffer.from(rewriteCss(payload.toString("utf8")), "utf8");
  }

  response.writeHead(apexResponse.statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

async function ensureApexLogin(client = primaryApex) {
  if (!client.username || !client.password) {
    throw new Error("Apex login is not configured on the server.");
  }

  const check = await requestApex("GET", "/Portal/RAndR/JobList.aspx", {}, Buffer.alloc(0), client);
  if (check.statusCode === 200 && check.body.toString("utf8").includes("Book Recovery Job")) {
    return;
  }

  const loginPage = await requestApex("GET", "/Portal/RAndR/WelcomeRAndR.aspx", {}, Buffer.alloc(0), client);
  const html = loginPage.body.toString("utf8");
  const form = new URLSearchParams({
    __LASTFOCUS: "",
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __VIEWSTATE: inputValue(html, "__VIEWSTATE"),
    __VIEWSTATEGENERATOR: inputValue(html, "__VIEWSTATEGENERATOR"),
    __SCROLLPOSITIONX: "0",
    __SCROLLPOSITIONY: "0",
    "ctl00$main$uxLoginTxt": client.username,
    "ctl00$main$uxPasswordTxt": client.password,
    "ctl00$main$uxLoginBtn": "Log In",
  });

  await requestApex("POST", "/Portal/RAndR/WelcomeRAndR.aspx", {
    "content-type": "application/x-www-form-urlencoded",
  }, Buffer.from(form.toString()), client);

  const afterLogin = await requestApex("GET", "/Portal/RAndR/JobList.aspx", {}, Buffer.alloc(0), client);
  if (!afterLogin.body.toString("utf8").includes("Book Recovery Job")) {
    throw new Error("Apex login did not complete.");
  }
}

async function requestBookingPageWithConfiguredAccount(client = primaryApex) {
  const page = await requestApex("GET", bookingPath, {}, Buffer.alloc(0), client);
  const html = page.body.toString("utf8");
  const accountValue = selectOptionValue(html, "ctl00_main_uxAccDdl", client.accountName);

  if (!accountValue) {
    return page;
  }

  const form = new URLSearchParams({
    "ctl00$ma$uxSrchTxt": "Search...",
    __LASTFOCUS: "",
    __EVENTTARGET: "ctl00$main$uxAccDdl",
    __EVENTARGUMENT: "",
    __VIEWSTATE: inputValue(html, "__VIEWSTATE"),
    __VIEWSTATEGENERATOR: inputValue(html, "__VIEWSTATEGENERATOR"),
    __SCROLLPOSITIONX: "0",
    __SCROLLPOSITIONY: "0",
    "ctl00$main$uxAccDdl": accountValue,
  });

  return requestApex(
    "POST",
    bookingPath,
    { "content-type": "application/x-www-form-urlencoded" },
    Buffer.from(form.toString()),
    client,
  );
}

function requestApex(method, apexPath, incomingHeaders = {}, body = Buffer.alloc(0), client = primaryApex) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: incomingHeaders.accept || "*/*",
      "Accept-Encoding": "identity",
      "User-Agent": incomingHeaders["user-agent"] || "Travel Support Europe booking launcher",
      Cookie: cookieHeader(client.cookieJar),
    };

    if (incomingHeaders["content-type"]) {
      headers["Content-Type"] = incomingHeaders["content-type"];
    }
    if (incomingHeaders.referer) {
      headers.Referer = incomingHeaders.referer;
    }

    if (body.length > 0) {
      headers["Content-Length"] = body.length;
    }

    const proxyRequest = https.request(
      {
        hostname: client.host,
        path: apexPath,
        method,
        headers,
      },
      (proxyResponse) => {
        storeCookies(proxyResponse.headers["set-cookie"], client.cookieJar);
        const chunks = [];
        proxyResponse.on("data", (chunk) => chunks.push(chunk));
        proxyResponse.on("end", () => {
          resolve({
            statusCode: proxyResponse.statusCode,
            headers: proxyResponse.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    proxyRequest.on("error", reject);
    if (body.length > 0) {
      proxyRequest.write(body);
    }
    proxyRequest.end();
  });
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const apiRequest = https.get(url, { headers: { "Accept": "application/json" } }, (apiResponse) => {
      const chunks = [];
      apiResponse.on("data", (chunk) => chunks.push(chunk));
      apiResponse.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({
            statusCode: apiResponse.statusCode,
            body: JSON.parse(text),
          });
        } catch (error) {
          reject(new Error("The location service returned an unreadable response."));
        }
      });
    });

    apiRequest.on("error", reject);
    apiRequest.setTimeout(10000, () => {
      apiRequest.destroy(new Error("The location service took too long to respond."));
    });
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function normaliseWhat3WordsLanguage(language) {
  const supported = new Set(["en", "de", "fr", "sv", "nl"]);
  const code = String(language || "en").split("-")[0].toLowerCase();
  return supported.has(code) ? code : "en";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function storeCookies(setCookieHeaders = [], targetCookieJar = cookieJar) {
  for (const cookie of setCookieHeaders) {
    const [pair] = cookie.split(";");
    const [name, value] = pair.split("=");
    if (name && value) {
      targetCookieJar.set(name.trim(), value.trim());
    }
  }
}

function cookieHeader(sourceCookieJar = cookieJar) {
  return [...sourceCookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function shouldMirrorBookingSubmit(method, apexPath, form) {
  if (!mirrorApexEnabled || method !== "POST" || apexPath !== bookingPath) {
    return false;
  }

  return form.has("ctl00$main$uxSaveBtn") || form.get("__EVENTTARGET") === "ctl00$main$uxSaveBtn";
}

async function mirrorBookingSubmission(primaryForm) {
  await ensureApexLogin(mirrorApex);

  const mirrorPage = await requestBookingPageWithConfiguredAccount(mirrorApex);
  const mirrorHtml = mirrorPage.body.toString("utf8");
  const mirrorForm = buildMirrorBookingForm(primaryForm, mirrorHtml, mirrorApex);
  const mirrorPayload = encodeMultipartForm(mirrorForm);

  return requestApex(
    "POST",
    bookingPath,
    {
      "content-type": mirrorPayload.contentType,
      referer: `https://${mirrorApex.host}${bookingPath}`,
    },
    mirrorPayload.body,
    mirrorApex,
  );
}

function buildMirrorBookingForm(primaryForm, mirrorHtml, client) {
  const mirrorForm = new URLSearchParams(primaryForm.toString());

  for (const [name, value] of hiddenInputs(mirrorHtml)) {
    mirrorForm.set(name, value);
  }

  const jobDateValue = client.jobDateName ? selectOptionValue(mirrorHtml, "ctl00_main_uxJobDateDdl", client.jobDateName) : "";
  const accountValue = selectOptionValue(mirrorHtml, "ctl00_main_uxAccDdl", client.accountName);
  const companyValue = client.companyName ? selectOptionValue(mirrorHtml, "ctl00_main_uxCmpDdl", client.companyName) : "";
  const siteValue = client.siteName ? selectOptionValue(mirrorHtml, "ctl00_main_uxSitesDdl", client.siteName) : "";
  const serviceValue = client.serviceName ? selectOptionValue(mirrorHtml, "ctl00_main_uxServiceDdl", client.serviceName) : "";

  if (jobDateValue) {
    mirrorForm.set("ctl00$main$uxJobDateDdl", jobDateValue);
  }
  if (accountValue) {
    mirrorForm.set("ctl00$main$uxAccDdl", accountValue);
  }
  if (companyValue) {
    mirrorForm.set("ctl00$main$uxCmpDdl", companyValue);
  }
  if (siteValue) {
    mirrorForm.set("ctl00$main$uxSitesDdl", siteValue);
  }
  if (serviceValue) {
    mirrorForm.set("ctl00$main$uxServiceDdl", serviceValue);
  }

  if (!mirrorForm.get("ctl00$main$uxOdometerTxt") && client.odometerValue) {
    mirrorForm.set("ctl00$main$uxOdometerTxt", client.odometerValue);
  }

  mirrorForm.set("__EVENTTARGET", "");
  mirrorForm.set("__EVENTARGUMENT", "");
  mirrorForm.set("ctl00$main$uxSaveBtn", "Save");
  return mirrorForm;
}

function parsePostedForm(headers, body) {
  const contentType = headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(body.toString("utf8"));
  }
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartForm(contentType, body);
  }
  return new URLSearchParams();
}

function parseMultipartForm(contentType, body) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    return new URLSearchParams();
  }

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const form = new URLSearchParams();
  const parts = body.toString("binary").split(boundary);

  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r?\n/, "");
    if (!part || part.startsWith("--")) {
      continue;
    }

    const separatorIndex = part.indexOf("\r\n\r\n");
    if (separatorIndex === -1) {
      continue;
    }

    const headerText = part.slice(0, separatorIndex);
    const valueText = part.slice(separatorIndex + 4).replace(/\r?\n--$/, "").replace(/\r?\n$/, "");
    const nameMatch = headerText.match(/name="([^"]+)"/i);
    if (!nameMatch || /filename="/i.test(headerText)) {
      continue;
    }

    form.append(nameMatch[1], Buffer.from(valueText, "binary").toString("utf8"));
  }

  return form;
}

function encodeMultipartForm(form) {
  const boundary = `----TseMirror${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];

  for (const [name, value] of form.entries()) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name.replace(/"/g, "%22")}"\r\n\r\n${value}\r\n`,
      "utf8",
    ));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

function hiddenInputs(html) {
  const inputs = [];
  const inputPattern = /<input\b[^>]*>/gi;
  let match;
  while ((match = inputPattern.exec(html))) {
    const input = match[0];
    const type = attributeValue(input, "type").toLowerCase();
    const name = attributeValue(input, "name");
    if (name && (!type || type === "hidden")) {
      inputs.push([name, attributeValue(input, "value")]);
    }
  }
  return inputs;
}

function attributeValue(tag, name) {
  const pattern = new RegExp(`${escapeRegex(name)}=["']([^"']*)["']`, "i");
  const match = tag.match(pattern);
  return match ? decodeHtml(match[1]) : "";
}

function sendSentPage(response, mirrorStatus) {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sent</title>
    <style>
      :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #223141; background: #eef6fa; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
      main { width: min(100%, 520px); border: 1px solid #dce7ef; border-radius: 8px; padding: 36px 28px; background: #fff; box-shadow: 0 18px 50px rgba(34, 49, 65, 0.18); text-align: center; }
      h1 { margin: 0; font-size: 2rem; }
      p { margin: 12px 0 0; color: #667281; font-weight: 700; }
    </style>
  </head>
  <body>
    <main data-mirror-status="${escapeHtml(mirrorStatus)}">
      <h1>Sent</h1>
      <p>Your roadside assistance request has been sent.</p>
    </main>
  </body>
</html>`;

  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inputValue(html, name) {
  const pattern = new RegExp(`<input[^>]*name=["']${escapeRegex(name)}["'][^>]*value=["']([^"']*)["']`, "i");
  const match = html.match(pattern);
  return match ? decodeHtml(match[1]) : "";
}

function selectOptionValue(html, selectId, optionText) {
  const selectPattern = new RegExp(`<select[^>]*id=["']${escapeRegex(selectId)}["'][\\s\\S]*?</select>`, "i");
  const selectMatch = html.match(selectPattern);
  if (!selectMatch) {
    return "";
  }

  const optionPattern = new RegExp(`<option[^>]*value=["']([^"']*)["'][^>]*>\\s*${escapeRegex(optionText)}\\s*</option>`, "i");
  const optionMatch = selectMatch[0].match(optionPattern);
  return optionMatch ? decodeHtml(optionMatch[1]) : "";
}

function rewriteHtml(html) {
  const rewritten = html
    .replace(/(href|src|action)=["']\/(?!apex\/)/gi, '$1="/apex/')
    .replace(/url\(["']?\//gi, 'url("/apex/')
    .replace(/PopupWin\("\/(?!apex\/)/gi, 'PopupWin("/apex/')
    .replace(/open\("\/(?!apex\/)/gi, 'open("/apex/')
    .replace(new RegExp(`https://${escapeRegex(apexHost)}/`, "gi"), "/apex/");

  return injectBookingTranslator(rewritten);
}

function rewriteCss(css) {
  return css.replace(/url\(["']?\//gi, 'url("/apex/');
}

function rewriteLocation(location) {
  const apexOrigin = `https://${apexHost}`;
  if (location.startsWith(`${apexOrigin}/`)) {
    return location.replace(apexOrigin, "/apex");
  }
  if (location.startsWith("/")) {
    return `/apex${location}`;
  }
  return location;
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeTableRowContaining(html, marker) {
  const rowPattern = new RegExp(
    `<tr\\b[^>]*>(?:(?!<tr\\b)[\\s\\S])*?${escapeRegex(marker)}(?:(?!<tr\\b)[\\s\\S])*?<\\/tr>`,
    "i",
  );
  return html.replace(rowPattern, "");
}

function selectOptionByText(html, selectId, optionText) {
  const selectPattern = new RegExp(
    `(<select\\b[^>]*id=["']${escapeRegex(selectId)}["'][^>]*>)([\\s\\S]*?)(<\\/select>)`,
    "i",
  );

  return html.replace(selectPattern, (_match, open, options, close) => {
    const optionPattern = new RegExp(`(<option\\b[^>]*>\\s*${escapeRegex(optionText)}\\s*<\\/option>)`, "i");
    const optionsWithoutSelection = options.replace(/\sselected(?:=["']selected["'])?/gi, "");
    const selectedOptions = optionsWithoutSelection.replace(optionPattern, (option) =>
      option.replace("<option", '<option selected="selected"'),
    );

    return `${open}${selectedOptions}${close}`;
  });
}

function injectBookingTranslator(html) {
  if (!html.includes("New Booking Request") && !html.includes("Job Details")) {
    return html;
  }

  const rowsToRemove = [
    "uxBookedByTxt",
    "uxBookedByNo",
    "uxOwnerCompTxt",
    "uxOwnerAddRessTxt",
    "uxPostcodeTxt",
    "uxMemberNoTxt",
    "uxVcDdl",
  ];
  const cleanedHtml = rowsToRemove.reduce(removeTableRowContaining, html);
  const siteDefaultedHtml = defaultSiteName
    ? selectOptionByText(cleanedHtml, "ctl00_main_uxSitesDdl", defaultSiteName)
    : cleanedHtml;
  const bookingHtml = siteDefaultedHtml.replace(/Upload File/g, "Send images");

  const script = String.raw`
<style>
  html,
  body {
    min-height: 100%;
  }

  body {
    background:
      linear-gradient(110deg, rgba(34, 49, 65, 0.78), rgba(41, 60, 172, 0.34)),
      url("/assets/tse-splash.jpeg") center center / cover no-repeat fixed !important;
    padding-bottom: 86px;
  }

  form,
  #aspnetForm,
  .main,
  .content,
  table {
    background-color: rgba(255, 255, 255, 0.9);
  }

  body > form,
  #aspnetForm {
    max-width: 1120px;
    margin: 24px auto !important;
    border: 1px solid rgba(220, 231, 239, 0.9);
    box-shadow: 0 18px 50px rgba(34, 49, 65, 0.24);
  }

  input,
  select,
  textarea {
    max-width: 100% !important;
  }

  .tse-support {
    display: inline-flex;
    align-items: center;
    position: fixed;
    right: 50%;
    bottom: 44px;
    z-index: 10000;
    transform: translateX(50%);
    border: 1px solid rgba(220, 231, 239, 0.95);
    border-radius: 6px;
    padding: 10px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 8px 24px rgba(34, 49, 65, 0.2);
    color: #223141;
    font: 800 15px/1.2 Arial, sans-serif;
    text-align: center;
    text-decoration: none;
    white-space: nowrap;
  }

  .tse-support-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #25d366;
    color: #ffffff;
    flex: 0 0 auto;
  }

  .tse-support-icon svg {
    display: block;
    width: 16px;
    height: 16px;
    fill: currentColor;
  }

  .tse-support-text {
    margin-left: 8px;
  }

  .tse-job-details-images-only .gl {
    display: none !important;
  }

  .tse-job-details-images-only tr {
    display: none !important;
  }

  .tse-job-details-images-only tr.tse-keep-send-images,
  .tse-job-details-images-only tr.tse-keep-case-number {
    display: table-row !important;
  }

  .tse-job-details-images-only tr.tse-keep-case-number .gl {
    display: table-cell !important;
  }

  .tse-job-details-images-only table {
    margin-top: 0 !important;
  }

  .tse-location-tools {
    display: grid;
    gap: 6px;
    margin-bottom: 8px;
  }

  .tse-location-button {
    width: fit-content;
    min-height: 38px;
    border: 1px solid #293cac;
    border-radius: 6px;
    padding: 7px 12px;
    background: #293cac;
    color: #ffffff;
    cursor: pointer;
    font: 800 14px/1.2 Arial, sans-serif;
  }

  .tse-location-button[disabled] {
    cursor: wait;
    opacity: 0.72;
  }

  .tse-location-status {
    color: #667281;
    font: 700 12px/1.35 Arial, sans-serif;
  }

  @media (max-width: 760px) {
    body {
      background-attachment: scroll !important;
      padding-bottom: 112px;
    }

    body > form,
    #aspnetForm {
      width: calc(100% - 20px) !important;
      margin: 10px auto 62px !important;
      overflow-x: hidden;
    }

    div[style*="float: left"] {
      float: none !important;
      width: 100% !important;
      min-width: 0 !important;
    }

    .gf,
    table {
      width: 100% !important;
    }

    td {
      display: block;
      width: 100% !important;
      padding: 4px 8px !important;
    }

    td.el {
      padding-top: 10px !important;
      font-weight: 700;
    }

    input.ei,
    select.ei,
    textarea.ei,
    input[type="text"],
    select,
    textarea {
      width: 100% !important;
      min-height: 40px;
      font-size: 16px !important;
    }

    textarea {
      min-height: 96px;
    }

    .ef {
      height: auto !important;
      padding: 8px 10px !important;
      box-sizing: border-box;
    }

    .actbut,
    input[type="submit"] {
      min-height: 44px;
      font-size: 16px !important;
    }

    .tse-support {
      bottom: 60px;
      padding: 10px;
    }

    .tse-location-button {
      width: 100%;
      min-height: 44px;
      font-size: 16px;
    }
  }
</style>
<script>
(function () {
  var defaultAccountName = ${JSON.stringify(defaultAccountName)};
  var defaultSiteName = ${JSON.stringify(defaultSiteName)};
  var defaultServiceName = ${JSON.stringify(defaultServiceName)};
  var defaultOrderPrefix = ${JSON.stringify(defaultOrderPrefix)};
  var supportPhone = ${JSON.stringify(supportPhone)};
  var supportWhatsappNumber = ${JSON.stringify(supportWhatsappNumber)};
  var dictionaries = {
    en: {
      "Owner Details": "Driver Details",
      "Symptom:": "Problem:",
      "Auth. Code:": "TSE Case No.",
      "Save": "Send"
    },
    de: {
      "New Booking Request": "Neue Hilfsanfrage",
      "Job Details": "Auftragsdetails",
      "Account:": "Konto:",
      "Select Account": "Konto auswahlen",
      "Company:": "Firma:",
      "Site:": "Standort:",
      "Order No:": "Auftragsnr.:",
      "Auth. Code:": "Autorisierungscode:",
      "Booked By": "Gebucht von",
      "Booking No.": "Buchungsnr.",
      "Send images": "Bilder senden",
      "Upload File": "Datei hochladen",
      "Choose File": "Datei auswahlen",
      "No File Attached": "Keine Datei angehangt",
      "Vehicle Details": "Fahrzeugdaten",
      "Class:": "Klasse:",
      "Registration:": "Kennzeichen:",
      "Fleet No:": "Flottennr.:",
      "Make:": "Marke:",
      "Model:": "Modell:",
      "Colour:": "Farbe:",
      "Fuel Type:": "Kraftstoff:",
      "Unspecified": "Nicht angegeben",
      "Trans. Type:": "Getriebe:",
      "Weight:": "Gewicht:",
      "Passengers:": "Passagiere:",
      "Adults": "Erwachsene",
      "Children": "Kinder",
      "Trailer:": "Anhänger:",
      "Recovery Information": "Hilfsinformationen",
      "Symptom:": "Problem:",
      "Location:": "Standort:",
      "Destination:": "Ziel:",
      "Odometer:": "Kilometerstand:",
      "Owner Details": "Fahrerdaten",
      "Name:": "Name:",
      "Address:": "Adresse:",
      "Postcode:": "Postleitzahl:",
      "Phone:": "Telefon:",
      "Alt. Phone:": "Alternatives Telefon:",
      "Member No:": "Mitgliedsnr.:",
      "Notes": "Notizen",
      "Save": "Senden"
    },
    fr: {
      "New Booking Request": "Nouvelle demande d'aide",
      "Job Details": "Details de la demande",
      "Account:": "Compte :",
      "Select Account": "Selectionner un compte",
      "Company:": "Societe :",
      "Site:": "Site :",
      "Order No:": "Numero de commande :",
      "Auth. Code:": "Code d'autorisation :",
      "Booked By": "Reserve par",
      "Booking No.": "Numero de reservation",
      "Send images": "Envoyer des images",
      "Upload File": "Importer un fichier",
      "Choose File": "Choisir un fichier",
      "No File Attached": "Aucun fichier joint",
      "Vehicle Details": "Details du vehicule",
      "Class:": "Categorie :",
      "Registration:": "Immatriculation :",
      "Fleet No:": "Numero de flotte :",
      "Make:": "Marque :",
      "Model:": "Modele :",
      "Colour:": "Couleur :",
      "Fuel Type:": "Carburant :",
      "Unspecified": "Non precise",
      "Trans. Type:": "Transmission :",
      "Weight:": "Poids :",
      "Passengers:": "Passagers :",
      "Adults": "Adultes",
      "Children": "Enfants",
      "Trailer:": "Remorque :",
      "Recovery Information": "Informations d'assistance",
      "Symptom:": "Probleme :",
      "Location:": "Lieu :",
      "Destination:": "Destination :",
      "Odometer:": "Compteur :",
      "Owner Details": "Details du conducteur",
      "Name:": "Nom :",
      "Address:": "Adresse :",
      "Postcode:": "Code postal :",
      "Phone:": "Telephone :",
      "Alt. Phone:": "Telephone alternatif :",
      "Member No:": "Numero membre :",
      "Notes": "Notes",
      "Save": "Envoyer"
    },
    sv: {
      "New Booking Request": "Ny hjalpforfragan",
      "Job Details": "Uppdragsdetaljer",
      "Account:": "Konto:",
      "Select Account": "Valj konto",
      "Company:": "Foretag:",
      "Site:": "Plats:",
      "Order No:": "Ordernr:",
      "Auth. Code:": "Auktorisationskod:",
      "Booked By": "Bokad av",
      "Booking No.": "Bokningsnr",
      "Send images": "Skicka bilder",
      "Upload File": "Ladda upp fil",
      "Choose File": "Valj fil",
      "No File Attached": "Ingen fil bifogad",
      "Vehicle Details": "Fordonsuppgifter",
      "Class:": "Klass:",
      "Registration:": "Registrering:",
      "Fleet No:": "Flottnr:",
      "Make:": "Marke:",
      "Model:": "Modell:",
      "Colour:": "Farg:",
      "Fuel Type:": "Bransle:",
      "Unspecified": "Ej angivet",
      "Trans. Type:": "Vaxellada:",
      "Weight:": "Vikt:",
      "Passengers:": "Passagerare:",
      "Adults": "Vuxna",
      "Children": "Barn",
      "Trailer:": "Slap:",
      "Recovery Information": "Hjalpinformation",
      "Symptom:": "Problem:",
      "Location:": "Plats:",
      "Destination:": "Destination:",
      "Odometer:": "Matarsstallning:",
      "Owner Details": "Foraruppgifter",
      "Name:": "Namn:",
      "Address:": "Adress:",
      "Postcode:": "Postnummer:",
      "Phone:": "Telefon:",
      "Alt. Phone:": "Alternativ telefon:",
      "Member No:": "Medlemsnr:",
      "Notes": "Anteckningar",
      "Save": "Skicka"
    },
    "de-AT": {
      "New Booking Request": "Neue Hilfsanfrage",
      "Job Details": "Auftragsdetails",
      "Account:": "Konto:",
      "Select Account": "Konto auswahlen",
      "Company:": "Firma:",
      "Site:": "Station:",
      "Order No:": "Auftragsnr.:",
      "Auth. Code:": "Autorisierungscode:",
      "Booked By": "Gebucht von",
      "Booking No.": "Buchungsnr.",
      "Send images": "Bilder senden",
      "Upload File": "Datei hochladen",
      "Choose File": "Datei auswahlen",
      "No File Attached": "Keine Datei angehangt",
      "Vehicle Details": "Fahrzeugdaten",
      "Class:": "Klasse:",
      "Registration:": "Kennzeichen:",
      "Fleet No:": "Flottennr.:",
      "Make:": "Marke:",
      "Model:": "Modell:",
      "Colour:": "Farbe:",
      "Fuel Type:": "Kraftstoff:",
      "Unspecified": "Nicht angegeben",
      "Trans. Type:": "Getriebe:",
      "Weight:": "Gewicht:",
      "Passengers:": "Mitfahrende:",
      "Adults": "Erwachsene",
      "Children": "Kinder",
      "Trailer:": "Anhänger:",
      "Recovery Information": "Hilfsinformationen",
      "Symptom:": "Problem:",
      "Location:": "Standort:",
      "Destination:": "Ziel:",
      "Odometer:": "Kilometerstand:",
      "Owner Details": "Fahrerdaten",
      "Name:": "Name:",
      "Address:": "Adresse:",
      "Postcode:": "Postleitzahl:",
      "Phone:": "Telefon:",
      "Alt. Phone:": "Alternatives Telefon:",
      "Member No:": "Mitgliedsnr.:",
      "Notes": "Notizen",
      "Save": "Senden"
    },
    nl: {
      "New Booking Request": "Nieuwe hulpaanvraag",
      "Job Details": "Opdrachtgegevens",
      "Account:": "Account:",
      "Select Account": "Selecteer account",
      "Company:": "Bedrijf:",
      "Site:": "Locatie:",
      "Order No:": "Ordernr.:",
      "Auth. Code:": "Autorisatiecode:",
      "Booked By": "Geboekt door",
      "Booking No.": "Boekingsnr.",
      "Send images": "Afbeeldingen verzenden",
      "Upload File": "Bestand uploaden",
      "Choose File": "Bestand kiezen",
      "No File Attached": "Geen bestand bijgevoegd",
      "Vehicle Details": "Voertuiggegevens",
      "Class:": "Klasse:",
      "Registration:": "Kenteken:",
      "Fleet No:": "Vlootnr.:",
      "Make:": "Merk:",
      "Model:": "Model:",
      "Colour:": "Kleur:",
      "Fuel Type:": "Brandstof:",
      "Unspecified": "Niet opgegeven",
      "Trans. Type:": "Transmissie:",
      "Weight:": "Gewicht:",
      "Passengers:": "Passagiers:",
      "Adults": "Volwassenen",
      "Children": "Kinderen",
      "Trailer:": "Aanhanger:",
      "Recovery Information": "Hulpinformatie",
      "Symptom:": "Probleem:",
      "Location:": "Locatie:",
      "Destination:": "Bestemming:",
      "Odometer:": "Kilometerstand:",
      "Owner Details": "Bestuurdersgegevens",
      "Name:": "Naam:",
      "Address:": "Adres:",
      "Postcode:": "Postcode:",
      "Phone:": "Telefoon:",
      "Alt. Phone:": "Alternatieve telefoon:",
      "Member No:": "Lidnr.:",
      "Notes": "Notities",
      "Save": "Verzenden"
    }
  };

  var languageCookie = document.cookie.match(/(?:^|; )tse-language=([^;]+)/);
  var language = languageCookie ? decodeURIComponent(languageCookie[1]) : "en";
  var baseLanguage = String(language || "en").split("-")[0];
  var dictionary = dictionaries[language] || dictionaries[baseLanguage] || dictionaries.en;
  var headingTranslations = {
    en: {
      "New Booking Request": "New booking request",
      "Job Details": "Job details",
      "Send images": "Send images",
      "Vehicle Details": "Vehicle details",
      "Recovery Information": "Recovery information",
      "Owner Details": "Driver details",
      "Notes": "Notes"
    },
    sq: {
      "New Booking Request": "Kërkesë e re për asistencë",
      "Job Details": "Detajet e rastit",
      "Send images": "Dërgo fotografi",
      "Vehicle Details": "Detajet e automjetit",
      "Recovery Information": "Informacioni i rikuperimit",
      "Owner Details": "Detajet e drejtuesit",
      "Notes": "Shënime"
    },
    bs: {
      "New Booking Request": "Novi zahtjev za pomoć",
      "Job Details": "Detalji slučaja",
      "Send images": "Pošalji slike",
      "Vehicle Details": "Podaci o vozilu",
      "Recovery Information": "Informacije o pomoći",
      "Owner Details": "Podaci o vozaču",
      "Notes": "Napomene"
    },
    bg: {
      "New Booking Request": "Нова заявка за помощ",
      "Job Details": "Детайли за случая",
      "Send images": "Изпращане на снимки",
      "Vehicle Details": "Данни за автомобила",
      "Recovery Information": "Информация за репатриране",
      "Owner Details": "Данни за водача",
      "Notes": "Бележки"
    },
    ca: {
      "New Booking Request": "Nova sol·licitud d'assistència",
      "Job Details": "Detalls del cas",
      "Send images": "Envia imatges",
      "Vehicle Details": "Dades del vehicle",
      "Recovery Information": "Informació de recuperació",
      "Owner Details": "Dades del conductor",
      "Notes": "Notes"
    },
    hr: {
      "New Booking Request": "Novi zahtjev za pomoć",
      "Job Details": "Detalji slučaja",
      "Send images": "Pošalji slike",
      "Vehicle Details": "Podaci o vozilu",
      "Recovery Information": "Informacije o pomoći",
      "Owner Details": "Podaci o vozaču",
      "Notes": "Napomene"
    },
    cs: {
      "New Booking Request": "Nová žádost o asistenci",
      "Job Details": "Podrobnosti případu",
      "Send images": "Odeslat obrázky",
      "Vehicle Details": "Údaje o vozidle",
      "Recovery Information": "Informace o odtahu",
      "Owner Details": "Údaje o řidiči",
      "Notes": "Poznámky"
    },
    da: {
      "New Booking Request": "Ny anmodning om hjælp",
      "Job Details": "Sagsoplysninger",
      "Send images": "Send billeder",
      "Vehicle Details": "Køretøjsoplysninger",
      "Recovery Information": "Bjærgningsoplysninger",
      "Owner Details": "Føreroplysninger",
      "Notes": "Noter"
    },
    nl: {
      "New Booking Request": "Nieuwe hulpaanvraag",
      "Job Details": "Opdrachtgegevens",
      "Send images": "Afbeeldingen verzenden",
      "Vehicle Details": "Voertuiggegevens",
      "Recovery Information": "Hulpinformatie",
      "Owner Details": "Bestuurdersgegevens",
      "Notes": "Notities"
    },
    et: {
      "New Booking Request": "Uus abipalve",
      "Job Details": "Juhtumi andmed",
      "Send images": "Saada pildid",
      "Vehicle Details": "Sõiduki andmed",
      "Recovery Information": "Taastamise teave",
      "Owner Details": "Juhi andmed",
      "Notes": "Märkused"
    },
    fi: {
      "New Booking Request": "Uusi avunpyyntö",
      "Job Details": "Tapauksen tiedot",
      "Send images": "Lähetä kuvat",
      "Vehicle Details": "Ajoneuvon tiedot",
      "Recovery Information": "Kuljetustiedot",
      "Owner Details": "Kuljettajan tiedot",
      "Notes": "Muistiinpanot"
    },
    de: {
      "New Booking Request": "Neue Hilfsanfrage",
      "Job Details": "Auftragsdetails",
      "Send images": "Bilder senden",
      "Vehicle Details": "Fahrzeugdaten",
      "Recovery Information": "Hilfsinformationen",
      "Owner Details": "Fahrerdaten",
      "Notes": "Notizen"
    },
    "de-AT": {
      "New Booking Request": "Neue Hilfsanfrage",
      "Job Details": "Auftragsdetails",
      "Send images": "Bilder senden",
      "Vehicle Details": "Fahrzeugdaten",
      "Recovery Information": "Hilfsinformationen",
      "Owner Details": "Fahrerdaten",
      "Notes": "Notizen"
    },
    fr: {
      "New Booking Request": "Nouvelle demande d'assistance",
      "Job Details": "Détails de la demande",
      "Send images": "Envoyer des images",
      "Vehicle Details": "Détails du véhicule",
      "Recovery Information": "Informations d'assistance",
      "Owner Details": "Détails du conducteur",
      "Notes": "Notes"
    },
    el: {
      "New Booking Request": "Νέο αίτημα βοήθειας",
      "Job Details": "Στοιχεία περιστατικού",
      "Send images": "Αποστολή εικόνων",
      "Vehicle Details": "Στοιχεία οχήματος",
      "Recovery Information": "Πληροφορίες οδικής βοήθειας",
      "Owner Details": "Στοιχεία οδηγού",
      "Notes": "Σημειώσεις"
    },
    hu: {
      "New Booking Request": "Új segítségkérés",
      "Job Details": "Eset adatai",
      "Send images": "Képek küldése",
      "Vehicle Details": "Jármű adatai",
      "Recovery Information": "Mentési információk",
      "Owner Details": "Vezető adatai",
      "Notes": "Megjegyzések"
    },
    is: {
      "New Booking Request": "Ný aðstoðarbeiðni",
      "Job Details": "Upplýsingar um mál",
      "Send images": "Senda myndir",
      "Vehicle Details": "Upplýsingar um ökutæki",
      "Recovery Information": "Upplýsingar um björgun",
      "Owner Details": "Upplýsingar um ökumann",
      "Notes": "Athugasemdir"
    },
    ga: {
      "New Booking Request": "Iarratas cabhrach nua",
      "Job Details": "Sonraí an cháis",
      "Send images": "Seol íomhánna",
      "Vehicle Details": "Sonraí na feithicle",
      "Recovery Information": "Eolas tarrthála",
      "Owner Details": "Sonraí an tiománaí",
      "Notes": "Nótaí"
    },
    it: {
      "New Booking Request": "Nuova richiesta di assistenza",
      "Job Details": "Dettagli del caso",
      "Send images": "Invia immagini",
      "Vehicle Details": "Dettagli del veicolo",
      "Recovery Information": "Informazioni di recupero",
      "Owner Details": "Dettagli del conducente",
      "Notes": "Note"
    },
    lv: {
      "New Booking Request": "Jauns palīdzības pieprasījums",
      "Job Details": "Gadījuma informācija",
      "Send images": "Sūtīt attēlus",
      "Vehicle Details": "Transportlīdzekļa dati",
      "Recovery Information": "Evakuācijas informācija",
      "Owner Details": "Vadītāja dati",
      "Notes": "Piezīmes"
    },
    lt: {
      "New Booking Request": "Naujas pagalbos prašymas",
      "Job Details": "Atvejo duomenys",
      "Send images": "Siųsti nuotraukas",
      "Vehicle Details": "Transporto priemonės duomenys",
      "Recovery Information": "Evakuacijos informacija",
      "Owner Details": "Vairuotojo duomenys",
      "Notes": "Pastabos"
    },
    mk: {
      "New Booking Request": "Ново барање за помош",
      "Job Details": "Детали за случајот",
      "Send images": "Испрати слики",
      "Vehicle Details": "Детали за возилото",
      "Recovery Information": "Информации за влечење",
      "Owner Details": "Детали за возачот",
      "Notes": "Белешки"
    },
    mt: {
      "New Booking Request": "Talba ġdida għall-għajnuna",
      "Job Details": "Dettalji tal-każ",
      "Send images": "Ibgħat stampi",
      "Vehicle Details": "Dettalji tal-vettura",
      "Recovery Information": "Informazzjoni dwar l-irkupru",
      "Owner Details": "Dettalji tas-sewwieq",
      "Notes": "Noti"
    },
    no: {
      "New Booking Request": "Ny forespørsel om hjelp",
      "Job Details": "Saksdetaljer",
      "Send images": "Send bilder",
      "Vehicle Details": "Kjøretøydetaljer",
      "Recovery Information": "Bergingsinformasjon",
      "Owner Details": "Førerdetaljer",
      "Notes": "Notater"
    },
    pl: {
      "New Booking Request": "Nowe zgłoszenie pomocy",
      "Job Details": "Szczegóły sprawy",
      "Send images": "Wyślij zdjęcia",
      "Vehicle Details": "Dane pojazdu",
      "Recovery Information": "Informacje o holowaniu",
      "Owner Details": "Dane kierowcy",
      "Notes": "Notatki"
    },
    pt: {
      "New Booking Request": "Novo pedido de assistência",
      "Job Details": "Detalhes do caso",
      "Send images": "Enviar imagens",
      "Vehicle Details": "Detalhes do veículo",
      "Recovery Information": "Informações de recuperação",
      "Owner Details": "Detalhes do condutor",
      "Notes": "Notas"
    },
    ro: {
      "New Booking Request": "Cerere nouă de asistență",
      "Job Details": "Detalii caz",
      "Send images": "Trimite imagini",
      "Vehicle Details": "Detalii vehicul",
      "Recovery Information": "Informații de recuperare",
      "Owner Details": "Detalii șofer",
      "Notes": "Note"
    },
    ru: {
      "New Booking Request": "Новая заявка на помощь",
      "Job Details": "Детали случая",
      "Send images": "Отправить изображения",
      "Vehicle Details": "Данные автомобиля",
      "Recovery Information": "Информация об эвакуации",
      "Owner Details": "Данные водителя",
      "Notes": "Заметки"
    },
    sr: {
      "New Booking Request": "Нови захтев за помоћ",
      "Job Details": "Детаљи случаја",
      "Send images": "Пошаљи слике",
      "Vehicle Details": "Подаци о возилу",
      "Recovery Information": "Информације о опоравку",
      "Owner Details": "Подаци о возачу",
      "Notes": "Напомене"
    },
    sk: {
      "New Booking Request": "Nová žiadosť o pomoc",
      "Job Details": "Podrobnosti prípadu",
      "Send images": "Odoslať obrázky",
      "Vehicle Details": "Údaje o vozidle",
      "Recovery Information": "Informácie o odťahu",
      "Owner Details": "Údaje o vodičovi",
      "Notes": "Poznámky"
    },
    sl: {
      "New Booking Request": "Nova zahteva za pomoč",
      "Job Details": "Podrobnosti primera",
      "Send images": "Pošlji slike",
      "Vehicle Details": "Podatki o vozilu",
      "Recovery Information": "Informacije o reševanju",
      "Owner Details": "Podatki o vozniku",
      "Notes": "Opombe"
    },
    es: {
      "New Booking Request": "Nueva solicitud de asistencia",
      "Job Details": "Detalles del caso",
      "Send images": "Enviar imágenes",
      "Vehicle Details": "Datos del vehículo",
      "Recovery Information": "Información de recuperación",
      "Owner Details": "Datos del conductor",
      "Notes": "Notas"
    },
    sv: {
      "New Booking Request": "Ny hjälpförfrågan",
      "Job Details": "Uppdragsdetaljer",
      "Send images": "Skicka bilder",
      "Vehicle Details": "Fordonsuppgifter",
      "Recovery Information": "Hjälpinformation",
      "Owner Details": "Föraruppgifter",
      "Notes": "Anteckningar"
    },
    tr: {
      "New Booking Request": "Yeni yardım talebi",
      "Job Details": "Vaka detayları",
      "Send images": "Resim gönder",
      "Vehicle Details": "Araç bilgileri",
      "Recovery Information": "Kurtarma bilgileri",
      "Owner Details": "Sürücü bilgileri",
      "Notes": "Notlar"
    },
    uk: {
      "New Booking Request": "Нова заявка на допомогу",
      "Job Details": "Деталі випадку",
      "Send images": "Надіслати зображення",
      "Vehicle Details": "Дані автомобіля",
      "Recovery Information": "Інформація про евакуацію",
      "Owner Details": "Дані водія",
      "Notes": "Нотатки"
    }
  };
  var headingText = headingTranslations[language] || headingTranslations[baseLanguage] || headingTranslations.en;
  dictionary = Object.assign({}, dictionary, headingText);
  var locationTranslations = {
    en: {
      button: "Use my location",
      loading: "Getting your location...",
      found: "Location added.",
      denied: "Please allow location access, or type the location manually.",
      unavailable: "Could not get the phone location. Please type the location manually.",
      notConfigured: "GPS added. what3words is not available yet."
    },
    de: {
      button: "Meinen Standort verwenden",
      loading: "Standort wird ermittelt...",
      found: "Standort hinzugefuegt.",
      denied: "Bitte Standortzugriff erlauben oder den Standort manuell eingeben.",
      unavailable: "Telefonstandort konnte nicht ermittelt werden. Bitte manuell eingeben.",
      notConfigured: "GPS hinzugefuegt. what3words ist noch nicht verfuegbar."
    },
    fr: {
      button: "Utiliser ma position",
      loading: "Recherche de la position...",
      found: "Position ajoutee.",
      denied: "Veuillez autoriser la position ou saisir le lieu manuellement.",
      unavailable: "Impossible d'obtenir la position du telephone. Veuillez saisir le lieu.",
      notConfigured: "GPS ajoute. what3words n'est pas encore disponible."
    },
    sv: {
      button: "Anvand min plats",
      loading: "Hamta plats...",
      found: "Plats tillagd.",
      denied: "Tillat platsatkomst eller skriv platsen manuellt.",
      unavailable: "Kunde inte hamta telefonens plats. Skriv platsen manuellt.",
      notConfigured: "GPS tillagd. what3words ar inte tillgangligt an."
    },
    "de-AT": {
      button: "Meinen Standort verwenden",
      loading: "Standort wird ermittelt...",
      found: "Standort hinzugefuegt.",
      denied: "Bitte Standortzugriff erlauben oder den Standort manuell eingeben.",
      unavailable: "Telefonstandort konnte nicht ermittelt werden. Bitte manuell eingeben.",
      notConfigured: "GPS hinzugefuegt. what3words ist noch nicht verfuegbar."
    },
    nl: {
      button: "Gebruik mijn locatie",
      loading: "Locatie ophalen...",
      found: "Locatie toegevoegd.",
      denied: "Sta locatietoegang toe of vul de locatie handmatig in.",
      unavailable: "Kon de telefoonlocatie niet ophalen. Vul de locatie handmatig in.",
      notConfigured: "GPS toegevoegd. what3words is nog niet beschikbaar."
    }
  };
  var locationText = locationTranslations[language] || locationTranslations[baseLanguage] || locationTranslations.en;
  var dropdownTranslationKeys = {
    "Select Account": "selectAccount",
    "Select a Company": "selectCompany",
    "Select a Site": "selectSite",
    "Select Service": "selectService",
    "Immediate": "immediate",
    "Unspecified": "unspecified",
    "Diesel": "diesel",
    "Petrol": "petrol",
    "EV": "ev",
    "Hybrid": "hybrid",
    "Hydrogen": "hydrogen",
    "LPG/Gas": "lpg",
    "M": "manual",
    "A": "automatic",
    "M 4WD": "manual4wd",
    "A 4WD": "automatic4wd",
    "Aborted Callout": "abortedCallout",
    "Low Loader Recovery": "lowLoaderRecovery",
    "Prestige Recovery": "prestigeRecovery",
    "Vehicle Recovery": "vehicleRecovery",
    "Roadside Assistance": "roadsideAssistance",
    "Road Traffic Collision": "roadTrafficCollision"
  };
  var dropdownTranslations = {
    en: {
      selectAccount: "Select account",
      selectCompany: "Select company",
      selectSite: "Select site",
      selectService: "Select service",
      immediate: "Immediate",
      unspecified: "Unspecified",
      diesel: "Diesel",
      petrol: "Petrol",
      ev: "Electric vehicle",
      hybrid: "Hybrid",
      hydrogen: "Hydrogen",
      lpg: "LPG/Gas",
      manual: "Manual",
      automatic: "Automatic",
      manual4wd: "Manual 4WD",
      automatic4wd: "Automatic 4WD",
      abortedCallout: "Aborted callout",
      lowLoaderRecovery: "Low loader recovery",
      prestigeRecovery: "Prestige recovery",
      vehicleRecovery: "Vehicle recovery",
      roadsideAssistance: "Roadside assistance",
      roadTrafficCollision: "Road traffic collision"
    },
    sq: {
      selectAccount: "Zgjidh llogarinë",
      selectCompany: "Zgjidh kompaninë",
      selectSite: "Zgjidh vendin",
      selectService: "Zgjidh shërbimin",
      immediate: "Menjëherë",
      unspecified: "E paspecifikuar",
      diesel: "Naftë",
      petrol: "Benzinë",
      ev: "Automjet elektrik",
      hybrid: "Hibrid",
      hydrogen: "Hidrogjen",
      lpg: "LPG/Gaz",
      manual: "Manuale",
      automatic: "Automatike",
      manual4wd: "Manuale 4WD",
      automatic4wd: "Automatike 4WD",
      abortedCallout: "Thirrje e anuluar",
      lowLoaderRecovery: "Rikuperim me platformë",
      prestigeRecovery: "Rikuperim premium",
      vehicleRecovery: "Rikuperim automjeti",
      roadsideAssistance: "Asistencë rrugore",
      roadTrafficCollision: "Aksident rrugor"
    },
    bs: {
      selectAccount: "Odaberite račun",
      selectCompany: "Odaberite kompaniju",
      selectSite: "Odaberite lokaciju",
      selectService: "Odaberite uslugu",
      immediate: "Odmah",
      unspecified: "Nije navedeno",
      diesel: "Dizel",
      petrol: "Benzin",
      ev: "Električno vozilo",
      hybrid: "Hibrid",
      hydrogen: "Vodik",
      lpg: "LPG/Plin",
      manual: "Ručni",
      automatic: "Automatski",
      manual4wd: "Ručni 4WD",
      automatic4wd: "Automatski 4WD",
      abortedCallout: "Otkazan izlazak",
      lowLoaderRecovery: "Oporavak niskopodnom prikolicom",
      prestigeRecovery: "Premium oporavak",
      vehicleRecovery: "Oporavak vozila",
      roadsideAssistance: "Pomoć na cesti",
      roadTrafficCollision: "Saobraćajna nesreća"
    },
    bg: {
      selectAccount: "Изберете акаунт",
      selectCompany: "Изберете компания",
      selectSite: "Изберете обект",
      selectService: "Изберете услуга",
      immediate: "Веднага",
      unspecified: "Не е посочено",
      diesel: "Дизел",
      petrol: "Бензин",
      ev: "Електрически автомобил",
      hybrid: "Хибрид",
      hydrogen: "Водород",
      lpg: "LPG/Газ",
      manual: "Ръчна",
      automatic: "Автоматична",
      manual4wd: "Ръчна 4WD",
      automatic4wd: "Автоматична 4WD",
      abortedCallout: "Отменено повикване",
      lowLoaderRecovery: "Репатриране с платформа",
      prestigeRecovery: "Премиум репатриране",
      vehicleRecovery: "Репатриране на автомобил",
      roadsideAssistance: "Пътна помощ",
      roadTrafficCollision: "Пътнотранспортно произшествие"
    },
    ca: {
      selectAccount: "Selecciona el compte",
      selectCompany: "Selecciona l'empresa",
      selectSite: "Selecciona el lloc",
      selectService: "Selecciona el servei",
      immediate: "Immediat",
      unspecified: "No especificat",
      diesel: "Dièsel",
      petrol: "Benzina",
      ev: "Vehicle elèctric",
      hybrid: "Híbrid",
      hydrogen: "Hidrogen",
      lpg: "GLP/Gas",
      manual: "Manual",
      automatic: "Automàtic",
      manual4wd: "Manual 4WD",
      automatic4wd: "Automàtic 4WD",
      abortedCallout: "Sortida cancel·lada",
      lowLoaderRecovery: "Recuperació amb plataforma baixa",
      prestigeRecovery: "Recuperació premium",
      vehicleRecovery: "Recuperació de vehicle",
      roadsideAssistance: "Assistència en carretera",
      roadTrafficCollision: "Accident de trànsit"
    },
    hr: {
      selectAccount: "Odaberite račun",
      selectCompany: "Odaberite tvrtku",
      selectSite: "Odaberite lokaciju",
      selectService: "Odaberite uslugu",
      immediate: "Odmah",
      unspecified: "Nije navedeno",
      diesel: "Dizel",
      petrol: "Benzin",
      ev: "Električno vozilo",
      hybrid: "Hibrid",
      hydrogen: "Vodik",
      lpg: "LPG/Plin",
      manual: "Ručni",
      automatic: "Automatski",
      manual4wd: "Ručni 4WD",
      automatic4wd: "Automatski 4WD",
      abortedCallout: "Otkazan poziv",
      lowLoaderRecovery: "Prijevoz niskom platformom",
      prestigeRecovery: "Premium izvlačenje",
      vehicleRecovery: "Izvlačenje vozila",
      roadsideAssistance: "Pomoć na cesti",
      roadTrafficCollision: "Prometna nesreća"
    },
    cs: {
      selectAccount: "Vyberte účet",
      selectCompany: "Vyberte společnost",
      selectSite: "Vyberte místo",
      selectService: "Vyberte službu",
      immediate: "Ihned",
      unspecified: "Neuvedeno",
      diesel: "Nafta",
      petrol: "Benzín",
      ev: "Elektrické vozidlo",
      hybrid: "Hybrid",
      hydrogen: "Vodík",
      lpg: "LPG/Plyn",
      manual: "Manuální",
      automatic: "Automatická",
      manual4wd: "Manuální 4WD",
      automatic4wd: "Automatická 4WD",
      abortedCallout: "Zrušený výjezd",
      lowLoaderRecovery: "Odtah na podvalníku",
      prestigeRecovery: "Prémiový odtah",
      vehicleRecovery: "Odtah vozidla",
      roadsideAssistance: "Silniční asistence",
      roadTrafficCollision: "Dopravní nehoda"
    },
    da: {
      selectAccount: "Vælg konto",
      selectCompany: "Vælg firma",
      selectSite: "Vælg sted",
      selectService: "Vælg service",
      immediate: "Straks",
      unspecified: "Ikke angivet",
      diesel: "Diesel",
      petrol: "Benzin",
      ev: "Elbil",
      hybrid: "Hybrid",
      hydrogen: "Brint",
      lpg: "LPG/Gas",
      manual: "Manuel",
      automatic: "Automatisk",
      manual4wd: "Manuel 4WD",
      automatic4wd: "Automatisk 4WD",
      abortedCallout: "Annulleret udkald",
      lowLoaderRecovery: "Bjærgning med lavlæsser",
      prestigeRecovery: "Premium bjærgning",
      vehicleRecovery: "Bjærgning af køretøj",
      roadsideAssistance: "Vejhjælp",
      roadTrafficCollision: "Trafikuheld"
    },
    nl: {
      selectAccount: "Selecteer account",
      selectCompany: "Selecteer bedrijf",
      selectSite: "Selecteer locatie",
      selectService: "Selecteer service",
      immediate: "Direct",
      unspecified: "Niet opgegeven",
      diesel: "Diesel",
      petrol: "Benzine",
      ev: "Elektrisch voertuig",
      hybrid: "Hybride",
      hydrogen: "Waterstof",
      lpg: "LPG/Gas",
      manual: "Handgeschakeld",
      automatic: "Automaat",
      manual4wd: "Handgeschakeld 4WD",
      automatic4wd: "Automaat 4WD",
      abortedCallout: "Geannuleerde oproep",
      lowLoaderRecovery: "Berging met oprijwagen",
      prestigeRecovery: "Premium berging",
      vehicleRecovery: "Voertuigberging",
      roadsideAssistance: "Pechhulp",
      roadTrafficCollision: "Verkeersongeval"
    },
    et: {
      selectAccount: "Vali konto",
      selectCompany: "Vali ettevõte",
      selectSite: "Vali asukoht",
      selectService: "Vali teenus",
      immediate: "Kohe",
      unspecified: "Määramata",
      diesel: "Diisel",
      petrol: "Bensiin",
      ev: "Elektrisõiduk",
      hybrid: "Hübriid",
      hydrogen: "Vesinik",
      lpg: "LPG/Gaas",
      manual: "Manuaal",
      automatic: "Automaat",
      manual4wd: "Manuaal 4WD",
      automatic4wd: "Automaat 4WD",
      abortedCallout: "Tühistatud väljakutse",
      lowLoaderRecovery: "Platvormveoki taastamine",
      prestigeRecovery: "Premium taastamine",
      vehicleRecovery: "Sõiduki taastamine",
      roadsideAssistance: "Teeabi",
      roadTrafficCollision: "Liiklusõnnetus"
    },
    fi: {
      selectAccount: "Valitse tili",
      selectCompany: "Valitse yritys",
      selectSite: "Valitse toimipaikka",
      selectService: "Valitse palvelu",
      immediate: "Heti",
      unspecified: "Ei määritelty",
      diesel: "Diesel",
      petrol: "Bensiini",
      ev: "Sähköajoneuvo",
      hybrid: "Hybridi",
      hydrogen: "Vety",
      lpg: "LPG/Kaasu",
      manual: "Manuaali",
      automatic: "Automaatti",
      manual4wd: "Manuaali 4WD",
      automatic4wd: "Automaatti 4WD",
      abortedCallout: "Peruttu hälytys",
      lowLoaderRecovery: "Kuljetus lavettiautolla",
      prestigeRecovery: "Premium-ajoneuvon kuljetus",
      vehicleRecovery: "Ajoneuvon kuljetus",
      roadsideAssistance: "Tiepalvelu",
      roadTrafficCollision: "Liikenneonnettomuus"
    },
    de: {
      selectAccount: "Konto auswählen",
      selectCompany: "Firma auswählen",
      selectSite: "Standort auswählen",
      selectService: "Service auswählen",
      immediate: "Sofort",
      unspecified: "Nicht angegeben",
      diesel: "Diesel",
      petrol: "Benzin",
      ev: "Elektrofahrzeug",
      hybrid: "Hybrid",
      hydrogen: "Wasserstoff",
      lpg: "LPG/Gas",
      manual: "Schaltgetriebe",
      automatic: "Automatik",
      manual4wd: "Schaltgetriebe 4WD",
      automatic4wd: "Automatik 4WD",
      abortedCallout: "Abgebrochener Einsatz",
      lowLoaderRecovery: "Tieflader-Bergung",
      prestigeRecovery: "Prestige-Bergung",
      vehicleRecovery: "Fahrzeugbergung",
      roadsideAssistance: "Pannenhilfe",
      roadTrafficCollision: "Verkehrsunfall"
    },
    "de-AT": {
      selectAccount: "Konto auswählen",
      selectCompany: "Firma auswählen",
      selectSite: "Standort auswählen",
      selectService: "Service auswählen",
      immediate: "Sofort",
      unspecified: "Nicht angegeben",
      diesel: "Diesel",
      petrol: "Benzin",
      ev: "Elektrofahrzeug",
      hybrid: "Hybrid",
      hydrogen: "Wasserstoff",
      lpg: "LPG/Gas",
      manual: "Schaltgetriebe",
      automatic: "Automatik",
      manual4wd: "Schaltgetriebe 4WD",
      automatic4wd: "Automatik 4WD",
      abortedCallout: "Abgebrochener Einsatz",
      lowLoaderRecovery: "Tieflader-Bergung",
      prestigeRecovery: "Prestige-Bergung",
      vehicleRecovery: "Fahrzeugbergung",
      roadsideAssistance: "Pannenhilfe",
      roadTrafficCollision: "Verkehrsunfall"
    },
    fr: {
      selectAccount: "Sélectionner un compte",
      selectCompany: "Sélectionner une société",
      selectSite: "Sélectionner un site",
      selectService: "Sélectionner un service",
      immediate: "Immédiat",
      unspecified: "Non précisé",
      diesel: "Diesel",
      petrol: "Essence",
      ev: "Véhicule électrique",
      hybrid: "Hybride",
      hydrogen: "Hydrogène",
      lpg: "GPL/Gaz",
      manual: "Manuelle",
      automatic: "Automatique",
      manual4wd: "Manuelle 4WD",
      automatic4wd: "Automatique 4WD",
      abortedCallout: "Intervention annulée",
      lowLoaderRecovery: "Dépannage sur plateau",
      prestigeRecovery: "Dépannage prestige",
      vehicleRecovery: "Dépannage du véhicule",
      roadsideAssistance: "Assistance routière",
      roadTrafficCollision: "Accident de la route"
    },
    el: {
      selectAccount: "Επιλέξτε λογαριασμό",
      selectCompany: "Επιλέξτε εταιρεία",
      selectSite: "Επιλέξτε τοποθεσία",
      selectService: "Επιλέξτε υπηρεσία",
      immediate: "Άμεσα",
      unspecified: "Μη καθορισμένο",
      diesel: "Ντίζελ",
      petrol: "Βενζίνη",
      ev: "Ηλεκτρικό όχημα",
      hybrid: "Υβριδικό",
      hydrogen: "Υδρογόνο",
      lpg: "LPG/Αέριο",
      manual: "Χειροκίνητο",
      automatic: "Αυτόματο",
      manual4wd: "Χειροκίνητο 4WD",
      automatic4wd: "Αυτόματο 4WD",
      abortedCallout: "Ακυρωμένη κλήση",
      lowLoaderRecovery: "Ανάκτηση με πλατφόρμα",
      prestigeRecovery: "Premium ανάκτηση",
      vehicleRecovery: "Ανάκτηση οχήματος",
      roadsideAssistance: "Οδική βοήθεια",
      roadTrafficCollision: "Τροχαίο ατύχημα"
    },
    hu: {
      selectAccount: "Fiók kiválasztása",
      selectCompany: "Cég kiválasztása",
      selectSite: "Helyszín kiválasztása",
      selectService: "Szolgáltatás kiválasztása",
      immediate: "Azonnal",
      unspecified: "Nincs megadva",
      diesel: "Dízel",
      petrol: "Benzin",
      ev: "Elektromos jármű",
      hybrid: "Hibrid",
      hydrogen: "Hidrogén",
      lpg: "LPG/Gáz",
      manual: "Kézi",
      automatic: "Automata",
      manual4wd: "Kézi 4WD",
      automatic4wd: "Automata 4WD",
      abortedCallout: "Törölt kiszállás",
      lowLoaderRecovery: "Mentés trélerrel",
      prestigeRecovery: "Prémium mentés",
      vehicleRecovery: "Járműmentés",
      roadsideAssistance: "Közúti segítség",
      roadTrafficCollision: "Közúti baleset"
    },
    is: {
      selectAccount: "Veldu reikning",
      selectCompany: "Veldu fyrirtæki",
      selectSite: "Veldu stað",
      selectService: "Veldu þjónustu",
      immediate: "Strax",
      unspecified: "Ótilgreint",
      diesel: "Dísel",
      petrol: "Bensín",
      ev: "Rafbíll",
      hybrid: "Tvinnbíll",
      hydrogen: "Vetni",
      lpg: "LPG/Gas",
      manual: "Beinskiptur",
      automatic: "Sjálfskiptur",
      manual4wd: "Beinskiptur 4WD",
      automatic4wd: "Sjálfskiptur 4WD",
      abortedCallout: "Aflýst útkall",
      lowLoaderRecovery: "Björgun með lághleðslubíl",
      prestigeRecovery: "Premium björgun",
      vehicleRecovery: "Björgun ökutækis",
      roadsideAssistance: "Vegaaðstoð",
      roadTrafficCollision: "Umferðarslys"
    },
    ga: {
      selectAccount: "Roghnaigh cuntas",
      selectCompany: "Roghnaigh cuideachta",
      selectSite: "Roghnaigh suíomh",
      selectService: "Roghnaigh seirbhís",
      immediate: "Láithreach",
      unspecified: "Gan sonrú",
      diesel: "Díosal",
      petrol: "Peitreal",
      ev: "Feithicil leictreach",
      hybrid: "Hibrid",
      hydrogen: "Hidrigin",
      lpg: "LPG/Gás",
      manual: "Láimhe",
      automatic: "Uathoibríoch",
      manual4wd: "Láimhe 4WD",
      automatic4wd: "Uathoibríoch 4WD",
      abortedCallout: "Glao amach curtha ar ceal",
      lowLoaderRecovery: "Tarrtháil le hardán íseal",
      prestigeRecovery: "Tarrtháil phréimhe",
      vehicleRecovery: "Tarrtháil feithicle",
      roadsideAssistance: "Cabhair ar thaobh an bhóthair",
      roadTrafficCollision: "Timpiste tráchta"
    },
    it: {
      selectAccount: "Seleziona account",
      selectCompany: "Seleziona azienda",
      selectSite: "Seleziona sede",
      selectService: "Seleziona servizio",
      immediate: "Immediato",
      unspecified: "Non specificato",
      diesel: "Diesel",
      petrol: "Benzina",
      ev: "Veicolo elettrico",
      hybrid: "Ibrido",
      hydrogen: "Idrogeno",
      lpg: "GPL/Gas",
      manual: "Manuale",
      automatic: "Automatico",
      manual4wd: "Manuale 4WD",
      automatic4wd: "Automatico 4WD",
      abortedCallout: "Chiamata annullata",
      lowLoaderRecovery: "Recupero con pianale",
      prestigeRecovery: "Recupero prestige",
      vehicleRecovery: "Recupero veicolo",
      roadsideAssistance: "Assistenza stradale",
      roadTrafficCollision: "Incidente stradale"
    },
    lv: {
      selectAccount: "Izvēlieties kontu",
      selectCompany: "Izvēlieties uzņēmumu",
      selectSite: "Izvēlieties vietu",
      selectService: "Izvēlieties pakalpojumu",
      immediate: "Nekavējoties",
      unspecified: "Nav norādīts",
      diesel: "Dīzelis",
      petrol: "Benzīns",
      ev: "Elektriskais transportlīdzeklis",
      hybrid: "Hibrīds",
      hydrogen: "Ūdeņradis",
      lpg: "LPG/Gāze",
      manual: "Manuālā",
      automatic: "Automātiskā",
      manual4wd: "Manuālā 4WD",
      automatic4wd: "Automātiskā 4WD",
      abortedCallout: "Atcelts izsaukums",
      lowLoaderRecovery: "Evakuācija ar platformu",
      prestigeRecovery: "Premium evakuācija",
      vehicleRecovery: "Transportlīdzekļa evakuācija",
      roadsideAssistance: "Palīdzība uz ceļa",
      roadTrafficCollision: "Ceļu satiksmes negadījums"
    },
    lt: {
      selectAccount: "Pasirinkite paskyrą",
      selectCompany: "Pasirinkite įmonę",
      selectSite: "Pasirinkite vietą",
      selectService: "Pasirinkite paslaugą",
      immediate: "Nedelsiant",
      unspecified: "Nenurodyta",
      diesel: "Dyzelinas",
      petrol: "Benzinas",
      ev: "Elektrinė transporto priemonė",
      hybrid: "Hibridas",
      hydrogen: "Vandenilis",
      lpg: "LPG/Dujos",
      manual: "Mechaninė",
      automatic: "Automatinė",
      manual4wd: "Mechaninė 4WD",
      automatic4wd: "Automatinė 4WD",
      abortedCallout: "Atšauktas iškvietimas",
      lowLoaderRecovery: "Evakuacija platforma",
      prestigeRecovery: "Premium evakuacija",
      vehicleRecovery: "Transporto priemonės evakuacija",
      roadsideAssistance: "Pagalba kelyje",
      roadTrafficCollision: "Eismo įvykis"
    },
    mk: {
      selectAccount: "Изберете сметка",
      selectCompany: "Изберете компанија",
      selectSite: "Изберете локација",
      selectService: "Изберете услуга",
      immediate: "Веднаш",
      unspecified: "Не е наведено",
      diesel: "Дизел",
      petrol: "Бензин",
      ev: "Електрично возило",
      hybrid: "Хибрид",
      hydrogen: "Водород",
      lpg: "LPG/Гас",
      manual: "Рачен",
      automatic: "Автоматски",
      manual4wd: "Рачен 4WD",
      automatic4wd: "Автоматски 4WD",
      abortedCallout: "Откажан повик",
      lowLoaderRecovery: "Влечење со платформа",
      prestigeRecovery: "Премиум влечење",
      vehicleRecovery: "Влечење возило",
      roadsideAssistance: "Помош на пат",
      roadTrafficCollision: "Сообраќајна несреќа"
    },
    mt: {
      selectAccount: "Agħżel kont",
      selectCompany: "Agħżel kumpanija",
      selectSite: "Agħżel sit",
      selectService: "Agħżel servizz",
      immediate: "Minnufih",
      unspecified: "Mhux speċifikat",
      diesel: "Diżil",
      petrol: "Petrol",
      ev: "Vettura elettrika",
      hybrid: "Ibrida",
      hydrogen: "Idroġenu",
      lpg: "LPG/Gass",
      manual: "Manwali",
      automatic: "Awtomatiku",
      manual4wd: "Manwali 4WD",
      automatic4wd: "Awtomatiku 4WD",
      abortedCallout: "Sejħa kkanċellata",
      lowLoaderRecovery: "Irkupru b'pjattaforma baxxa",
      prestigeRecovery: "Irkupru premium",
      vehicleRecovery: "Irkupru tal-vettura",
      roadsideAssistance: "Għajnuna fit-triq",
      roadTrafficCollision: "Inċident tat-traffiku"
    },
    no: {
      selectAccount: "Velg konto",
      selectCompany: "Velg selskap",
      selectSite: "Velg sted",
      selectService: "Velg tjeneste",
      immediate: "Umiddelbart",
      unspecified: "Ikke spesifisert",
      diesel: "Diesel",
      petrol: "Bensin",
      ev: "Elbil",
      hybrid: "Hybrid",
      hydrogen: "Hydrogen",
      lpg: "LPG/Gass",
      manual: "Manuell",
      automatic: "Automat",
      manual4wd: "Manuell 4WD",
      automatic4wd: "Automat 4WD",
      abortedCallout: "Avbrutt utrykning",
      lowLoaderRecovery: "Berging med lavlaster",
      prestigeRecovery: "Premium berging",
      vehicleRecovery: "Bilberging",
      roadsideAssistance: "Veihjelp",
      roadTrafficCollision: "Trafikkulykke"
    },
    pl: {
      selectAccount: "Wybierz konto",
      selectCompany: "Wybierz firmę",
      selectSite: "Wybierz lokalizację",
      selectService: "Wybierz usługę",
      immediate: "Natychmiast",
      unspecified: "Nie określono",
      diesel: "Diesel",
      petrol: "Benzyna",
      ev: "Pojazd elektryczny",
      hybrid: "Hybryda",
      hydrogen: "Wodór",
      lpg: "LPG/Gaz",
      manual: "Manualna",
      automatic: "Automatyczna",
      manual4wd: "Manualna 4WD",
      automatic4wd: "Automatyczna 4WD",
      abortedCallout: "Anulowane wezwanie",
      lowLoaderRecovery: "Holowanie lawetą",
      prestigeRecovery: "Holowanie premium",
      vehicleRecovery: "Holowanie pojazdu",
      roadsideAssistance: "Pomoc drogowa",
      roadTrafficCollision: "Wypadek drogowy"
    },
    pt: {
      selectAccount: "Selecionar conta",
      selectCompany: "Selecionar empresa",
      selectSite: "Selecionar local",
      selectService: "Selecionar serviço",
      immediate: "Imediato",
      unspecified: "Não especificado",
      diesel: "Diesel",
      petrol: "Gasolina",
      ev: "Veículo elétrico",
      hybrid: "Híbrido",
      hydrogen: "Hidrogénio",
      lpg: "GPL/Gás",
      manual: "Manual",
      automatic: "Automático",
      manual4wd: "Manual 4WD",
      automatic4wd: "Automático 4WD",
      abortedCallout: "Chamada cancelada",
      lowLoaderRecovery: "Reboque com plataforma",
      prestigeRecovery: "Reboque premium",
      vehicleRecovery: "Reboque de veículo",
      roadsideAssistance: "Assistência em estrada",
      roadTrafficCollision: "Acidente rodoviário"
    },
    ro: {
      selectAccount: "Selectați contul",
      selectCompany: "Selectați compania",
      selectSite: "Selectați locația",
      selectService: "Selectați serviciul",
      immediate: "Imediat",
      unspecified: "Nespecificat",
      diesel: "Diesel",
      petrol: "Benzină",
      ev: "Vehicul electric",
      hybrid: "Hibrid",
      hydrogen: "Hidrogen",
      lpg: "GPL/Gaz",
      manual: "Manuală",
      automatic: "Automată",
      manual4wd: "Manuală 4WD",
      automatic4wd: "Automată 4WD",
      abortedCallout: "Intervenție anulată",
      lowLoaderRecovery: "Recuperare cu platformă",
      prestigeRecovery: "Recuperare premium",
      vehicleRecovery: "Recuperare vehicul",
      roadsideAssistance: "Asistență rutieră",
      roadTrafficCollision: "Accident rutier"
    },
    ru: {
      selectAccount: "Выберите аккаунт",
      selectCompany: "Выберите компанию",
      selectSite: "Выберите площадку",
      selectService: "Выберите услугу",
      immediate: "Немедленно",
      unspecified: "Не указано",
      diesel: "Дизель",
      petrol: "Бензин",
      ev: "Электромобиль",
      hybrid: "Гибрид",
      hydrogen: "Водород",
      lpg: "LPG/Газ",
      manual: "Механическая",
      automatic: "Автоматическая",
      manual4wd: "Механическая 4WD",
      automatic4wd: "Автоматическая 4WD",
      abortedCallout: "Отмененный вызов",
      lowLoaderRecovery: "Эвакуация на платформе",
      prestigeRecovery: "Премиум эвакуация",
      vehicleRecovery: "Эвакуация автомобиля",
      roadsideAssistance: "Помощь на дороге",
      roadTrafficCollision: "ДТП"
    },
    sr: {
      selectAccount: "Изаберите налог",
      selectCompany: "Изаберите компанију",
      selectSite: "Изаберите локацију",
      selectService: "Изаберите услугу",
      immediate: "Одмах",
      unspecified: "Није наведено",
      diesel: "Дизел",
      petrol: "Бензин",
      ev: "Електрично возило",
      hybrid: "Хибрид",
      hydrogen: "Водоник",
      lpg: "LPG/Гас",
      manual: "Мануелни",
      automatic: "Аутоматски",
      manual4wd: "Мануелни 4WD",
      automatic4wd: "Аутоматски 4WD",
      abortedCallout: "Отказан позив",
      lowLoaderRecovery: "Опоравак платформом",
      prestigeRecovery: "Премиум опоравак",
      vehicleRecovery: "Опоравак возила",
      roadsideAssistance: "Помоћ на путу",
      roadTrafficCollision: "Саобраћајна несрећа"
    },
    sk: {
      selectAccount: "Vyberte účet",
      selectCompany: "Vyberte spoločnosť",
      selectSite: "Vyberte miesto",
      selectService: "Vyberte službu",
      immediate: "Ihneď",
      unspecified: "Neuvedené",
      diesel: "Nafta",
      petrol: "Benzín",
      ev: "Elektrické vozidlo",
      hybrid: "Hybrid",
      hydrogen: "Vodík",
      lpg: "LPG/Plyn",
      manual: "Manuálna",
      automatic: "Automatická",
      manual4wd: "Manuálna 4WD",
      automatic4wd: "Automatická 4WD",
      abortedCallout: "Zrušený výjazd",
      lowLoaderRecovery: "Odtah na podvalníku",
      prestigeRecovery: "Prémiový odťah",
      vehicleRecovery: "Odtah vozidla",
      roadsideAssistance: "Cestná asistencia",
      roadTrafficCollision: "Dopravná nehoda"
    },
    sl: {
      selectAccount: "Izberite račun",
      selectCompany: "Izberite podjetje",
      selectSite: "Izberite lokacijo",
      selectService: "Izberite storitev",
      immediate: "Takoj",
      unspecified: "Ni navedeno",
      diesel: "Dizel",
      petrol: "Bencin",
      ev: "Električno vozilo",
      hybrid: "Hibrid",
      hydrogen: "Vodik",
      lpg: "LPG/Plin",
      manual: "Ročni",
      automatic: "Avtomatski",
      manual4wd: "Ročni 4WD",
      automatic4wd: "Avtomatski 4WD",
      abortedCallout: "Preklican klic",
      lowLoaderRecovery: "Prevoz z nizko platformo",
      prestigeRecovery: "Premium reševanje",
      vehicleRecovery: "Reševanje vozila",
      roadsideAssistance: "Pomoč na cesti",
      roadTrafficCollision: "Prometna nesreča"
    },
    es: {
      selectAccount: "Seleccionar cuenta",
      selectCompany: "Seleccionar empresa",
      selectSite: "Seleccionar ubicación",
      selectService: "Seleccionar servicio",
      immediate: "Inmediato",
      unspecified: "No especificado",
      diesel: "Diésel",
      petrol: "Gasolina",
      ev: "Vehículo eléctrico",
      hybrid: "Híbrido",
      hydrogen: "Hidrógeno",
      lpg: "GLP/Gas",
      manual: "Manual",
      automatic: "Automático",
      manual4wd: "Manual 4WD",
      automatic4wd: "Automático 4WD",
      abortedCallout: "Salida cancelada",
      lowLoaderRecovery: "Recuperación con plataforma",
      prestigeRecovery: "Recuperación premium",
      vehicleRecovery: "Recuperación de vehículo",
      roadsideAssistance: "Asistencia en carretera",
      roadTrafficCollision: "Accidente de tráfico"
    },
    sv: {
      selectAccount: "Välj konto",
      selectCompany: "Välj företag",
      selectSite: "Välj plats",
      selectService: "Välj tjänst",
      immediate: "Omedelbart",
      unspecified: "Ej angivet",
      diesel: "Diesel",
      petrol: "Bensin",
      ev: "Elfordon",
      hybrid: "Hybrid",
      hydrogen: "Vätgas",
      lpg: "LPG/Gas",
      manual: "Manuell",
      automatic: "Automat",
      manual4wd: "Manuell 4WD",
      automatic4wd: "Automat 4WD",
      abortedCallout: "Avbrutet uppdrag",
      lowLoaderRecovery: "Bärgning med maskintrailer",
      prestigeRecovery: "Premiumbärgning",
      vehicleRecovery: "Fordonsbärgning",
      roadsideAssistance: "Vägassistans",
      roadTrafficCollision: "Trafikolycka"
    },
    tr: {
      selectAccount: "Hesap seçin",
      selectCompany: "Şirket seçin",
      selectSite: "Konum seçin",
      selectService: "Hizmet seçin",
      immediate: "Hemen",
      unspecified: "Belirtilmemiş",
      diesel: "Dizel",
      petrol: "Benzin",
      ev: "Elektrikli araç",
      hybrid: "Hibrit",
      hydrogen: "Hidrojen",
      lpg: "LPG/Gaz",
      manual: "Manuel",
      automatic: "Otomatik",
      manual4wd: "Manuel 4WD",
      automatic4wd: "Otomatik 4WD",
      abortedCallout: "İptal edilen çağrı",
      lowLoaderRecovery: "Platformlu kurtarma",
      prestigeRecovery: "Premium kurtarma",
      vehicleRecovery: "Araç kurtarma",
      roadsideAssistance: "Yol yardımı",
      roadTrafficCollision: "Trafik kazası"
    },
    uk: {
      selectAccount: "Виберіть обліковий запис",
      selectCompany: "Виберіть компанію",
      selectSite: "Виберіть місце",
      selectService: "Виберіть послугу",
      immediate: "Негайно",
      unspecified: "Не вказано",
      diesel: "Дизель",
      petrol: "Бензин",
      ev: "Електромобіль",
      hybrid: "Гібрид",
      hydrogen: "Водень",
      lpg: "LPG/Газ",
      manual: "Механічна",
      automatic: "Автоматична",
      manual4wd: "Механічна 4WD",
      automatic4wd: "Автоматична 4WD",
      abortedCallout: "Скасований виклик",
      lowLoaderRecovery: "Евакуація на платформі",
      prestigeRecovery: "Преміум евакуація",
      vehicleRecovery: "Евакуація автомобіля",
      roadsideAssistance: "Допомога на дорозі",
      roadTrafficCollision: "ДТП"
    }
  };
  var dropdownText = dropdownTranslations[language] || dropdownTranslations[baseLanguage] || dropdownTranslations.en;

  function clean(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function translateTextNode(node) {
    var key = clean(node.nodeValue);
    if (dictionary[key]) {
      node.nodeValue = node.nodeValue.replace(key, dictionary[key]);
    }
  }

  function translateElement(element) {
    if ((element.tagName === "INPUT" || element.tagName === "BUTTON") && element.value) {
      var valueKey = clean(element.value);
      if (dictionary[valueKey]) {
        element.value = dictionary[valueKey];
      }
    }

    if (element.tagName === "OPTION") {
      var optionKey = clean(element.textContent);
      if (dictionary[optionKey]) {
        element.textContent = dictionary[optionKey];
      }
    }
  }

  var symptomOptionTranslations = {
    en: {
      "OTHER": "Other",
      "ALARM / IMMOBILISER": "Alarm or immobiliser system",
      "ALTERNATOR": "Suspected alternator",
      "AUTO GBOX": "Automatic gearbox",
      "BATTERY": "Flat battery",
      "BATTERY LLO": "Flat battery - lights left on",
      "BODY": "Vehicle body",
      "BRAKE NOISE": "Brake noise",
      "BRAKE PEDAL": "Brake hydraulic failure",
      "CLUTCH": "Clutch failure",
      "CLUTCH LINKAGE": "Clutch pedal, cable or hydraulics",
      "CONVERTIBLE": "Roof system fault",
      "COOLANT LEAK": "Coolant leak",
      "CUT OUT": "Cut out while driving",
      "DEMISTER": "Heater blower or demister not working",
      "DRIVEBELT": "Alternator or steering drive belt failure",
      "DRIVESHAFT": "Driveshaft or prop shaft failure",
      "ENGINE": "Engine failure",
      "ENGINE NOISE": "Noise from engine",
      "ENGINE OIL": "Oil leak",
      "EXHAUST": "Exhaust pipe",
      "FIRE": "Fire damage",
      "FLOOD": "Driven through flood water",
      "FUEL ACCELERATOR": "Accelerator pedal or cable",
      "FUEL DIESEL": "Fuel - diesel",
      "FUEL LEAK": "Fuel leak",
      "FUEL PETROL": "Fuel - petrol",
      "GEAR LINKAGE": "Gear linkage fault",
      "GEARBOX / DRIVE": "Manual gearbox",
      "HANDBRAKE": "Handbrake failure",
      "HEAD GASKET": "Head gasket",
      "HORN": "Horn system",
      "HV CHARGE": "Electric vehicle will not charge",
      "ILLNESS": "Driver illness or injury",
      "KEYS": "Keys lost, stolen or broken",
      "KEYS LOCK OUT": "Keys locked in vehicle",
      "LIGHTS": "External light fault",
      "LOCKS": "Locks jammed or cannot lock/unlock",
      "LOP": "Engine runs roughly",
      "LOP WLO": "Engine runs roughly with warning light",
      "MISFUEL DIESEL": "Petrol in diesel",
      "MISFUEL OTHER": "Wrong fluid or fuel",
      "MISFUEL PETROL": "Diesel in petrol",
      "NOISE": "Noise while driving",
      "NON START DOK": "Dead on key, no lights",
      "NON START TONF": "Turning over but not firing",
      "OVERHEAT": "High temperature or steam",
      "PUNCTURE": "Flat tyre - spare available",
      "PUNCTURE BOLTS": "Wheel nuts or locking bolts missing/broken",
      "PUNCTURE FOAM": "Flat tyre - foam kit",
      "PUNCTURE MULTI": "More than one tyre punctured",
      "PUNCTURE NS": "Flat tyre - no spare available",
      "REPATRIATION": "Vehicle repatriation",
      "RTC": "Road traffic collision",
      "SEAT BELT": "Seat belt fault",
      "SMELL": "Unknown smell or fumes",
      "SMOKING": "Smoke from exhaust",
      "STALLING": "Engine stalls",
      "STEERING FAILURE": "Steering joint or bush fault",
      "STEERING HEAVY": "Heavy steering / power steering not working",
      "STEERING LOCK": "Steering lock or ignition barrel",
      "STOLEN": "Vehicle stolen",
      "STUCK": "Vehicle stuck",
      "SUSPENSION": "Broken suspension",
      "TIMING BELT": "Timing belt suspected",
      "TRAILER": "Trailer or caravan fault",
      "TURBO": "Turbo fault",
      "VANDALISED": "Vehicle vandalised",
      "WASHERS WIPERS": "Windscreen washer or wiper fault",
      "WHEEL": "Wheel loose or adrift",
      "WINDOWS": "Window fault",
      "WLO ORANGE": "Orange warning light",
      "WLO RED": "Red warning light"
    },
    de: {
      "OTHER": "Sonstiges",
      "ALARM / IMMOBILISER": "Alarmanlage oder Wegfahrsperre",
      "ALTERNATOR": "Lichtmaschine vermutlich defekt",
      "AUTO GBOX": "Automatikgetriebe",
      "BATTERY": "Batterie leer",
      "BATTERY LLO": "Batterie leer - Licht angelassen",
      "BODY": "Karosserie",
      "BRAKE NOISE": "Bremsgeraeusche",
      "BRAKE PEDAL": "Hydraulischer Bremsfehler",
      "CLUTCH": "Kupplungsfehler",
      "CLUTCH LINKAGE": "Kupplungspedal, Seilzug oder Hydraulik",
      "CONVERTIBLE": "Dachsystemfehler",
      "COOLANT LEAK": "Kuehlmittelverlust",
      "CUT OUT": "Motor waehrend der Fahrt ausgegangen",
      "DEMISTER": "Heizung oder Geblaese funktioniert nicht",
      "DRIVEBELT": "Riemen fuer Lichtmaschine oder Lenkung defekt",
      "DRIVESHAFT": "Antriebswelle oder Kardanwelle defekt",
      "ENGINE": "Motorfehler",
      "ENGINE NOISE": "Geraeusch vom Motor",
      "ENGINE OIL": "Oelverlust",
      "EXHAUST": "Auspuff",
      "FIRE": "Brandschaden",
      "FLOOD": "Durch Wasser gefahren",
      "FUEL ACCELERATOR": "Gaspedal oder Gaszug",
      "FUEL DIESEL": "Kraftstoff - Diesel",
      "FUEL LEAK": "Kraftstoffverlust",
      "FUEL PETROL": "Kraftstoff - Benzin",
      "GEAR LINKAGE": "Schaltgestaengefehler",
      "GEARBOX / DRIVE": "Schaltgetriebe",
      "HANDBRAKE": "Handbremse defekt",
      "HEAD GASKET": "Zylinderkopfdichtung",
      "HORN": "Hupe",
      "HV CHARGE": "Elektrofahrzeug laedt nicht",
      "ILLNESS": "Fahrer krank oder verletzt",
      "KEYS": "Schluessel verloren, gestohlen oder defekt",
      "KEYS LOCK OUT": "Schluessel im Fahrzeug eingeschlossen",
      "LIGHTS": "Aussenbeleuchtung defekt",
      "LOCKS": "Schloss klemmt oder oeffnet/schliesst nicht",
      "LOP": "Motor laeuft unrund",
      "LOP WLO": "Motor laeuft unrund mit Warnleuchte",
      "MISFUEL DIESEL": "Benzin in Diesel getankt",
      "MISFUEL OTHER": "Falsche Fluessigkeit oder falscher Kraftstoff",
      "MISFUEL PETROL": "Diesel in Benziner getankt",
      "NOISE": "Geraeusch waehrend der Fahrt",
      "NON START DOK": "Keine Reaktion beim Starten",
      "NON START TONF": "Dreht, startet aber nicht",
      "OVERHEAT": "Hohe Temperatur oder Dampf",
      "PUNCTURE": "Reifenpanne - Ersatzrad vorhanden",
      "PUNCTURE BOLTS": "Radmuttern oder Sicherungsbolzen fehlen/defekt",
      "PUNCTURE FOAM": "Reifenpanne - Pannenset",
      "PUNCTURE MULTI": "Mehrere Reifen beschaedigt",
      "PUNCTURE NS": "Reifenpanne - kein Ersatzrad",
      "REPATRIATION": "Fahrzeugrueckfuehrung",
      "RTC": "Verkehrsunfall",
      "SEAT BELT": "Sicherheitsgurt defekt",
      "SMELL": "Unbekannter Geruch oder Daempfe",
      "SMOKING": "Rauch aus dem Auspuff",
      "STALLING": "Motor geht aus",
      "STEERING FAILURE": "Lenkungsgelenk oder Buchse defekt",
      "STEERING HEAVY": "Lenkung schwergangig / Servolenkung defekt",
      "STEERING LOCK": "Lenkschloss oder Zuendschloss",
      "STOLEN": "Fahrzeug gestohlen",
      "STUCK": "Fahrzeug festgefahren",
      "SUSPENSION": "Federung defekt",
      "TIMING BELT": "Zahnriemen vermutlich defekt",
      "TRAILER": "Anhaenger oder Wohnwagen defekt",
      "TURBO": "Turbo defekt",
      "VANDALISED": "Fahrzeug vandalisiert",
      "WASHERS WIPERS": "Scheibenwaschanlage oder Wischer defekt",
      "WHEEL": "Rad locker",
      "WINDOWS": "Fenster defekt",
      "WLO ORANGE": "Orange Warnleuchte",
      "WLO RED": "Rote Warnleuchte"
    }
  };

  symptomOptionTranslations["de-AT"] = symptomOptionTranslations.de;
  symptomOptionTranslations.fr = {
    "OTHER": "Autre",
    "ALARM / IMMOBILISER": "Alarme ou antidémarrage",
    "ALTERNATOR": "Alternateur suspecté",
    "AUTO GBOX": "Boîte automatique",
    "BATTERY": "Batterie à plat",
    "BATTERY LLO": "Batterie à plat - feux laissés allumés",
    "BODY": "Carrosserie",
    "BRAKE NOISE": "Bruit de frein",
    "BRAKE PEDAL": "Défaillance hydraulique des freins",
    "CLUTCH": "Défaillance de l'embrayage",
    "CLUTCH LINKAGE": "Pédale, câble ou hydraulique d'embrayage",
    "CONVERTIBLE": "Défaut du système de toit",
    "COOLANT LEAK": "Fuite de liquide de refroidissement",
    "CUT OUT": "Coupure moteur en roulant",
    "DEMISTER": "Chauffage ou désembuage hors service",
    "DRIVEBELT": "Courroie d'alternateur ou de direction",
    "DRIVESHAFT": "Arbre de transmission défectueux",
    "ENGINE": "Défaillance moteur",
    "ENGINE NOISE": "Bruit moteur",
    "ENGINE OIL": "Fuite d'huile",
    "EXHAUST": "Échappement",
    "FIRE": "Dégâts d'incendie",
    "FLOOD": "Passage dans l'eau",
    "FUEL ACCELERATOR": "Pédale ou câble d'accélérateur",
    "FUEL DIESEL": "Carburant - diesel",
    "FUEL LEAK": "Fuite de carburant",
    "FUEL PETROL": "Carburant - essence",
    "GEAR LINKAGE": "Défaut de tringlerie de boîte",
    "GEARBOX / DRIVE": "Boîte manuelle",
    "HANDBRAKE": "Frein à main défectueux",
    "HEAD GASKET": "Joint de culasse",
    "HORN": "Klaxon",
    "HV CHARGE": "Véhicule électrique ne charge pas",
    "ILLNESS": "Conducteur malade ou blessé",
    "KEYS": "Clés perdues, volées ou cassées",
    "KEYS LOCK OUT": "Clés enfermées dans le véhicule",
    "LIGHTS": "Éclairage extérieur défectueux",
    "LOCKS": "Serrure bloquée ou impossible à verrouiller/déverrouiller",
    "LOP": "Moteur tourne mal",
    "LOP WLO": "Moteur tourne mal avec voyant",
    "MISFUEL DIESEL": "Essence dans diesel",
    "MISFUEL OTHER": "Mauvais liquide ou carburant",
    "MISFUEL PETROL": "Diesel dans essence",
    "NOISE": "Bruit en roulant",
    "NON START DOK": "Aucune réaction au démarrage",
    "NON START TONF": "Le moteur tourne mais ne démarre pas",
    "OVERHEAT": "Température élevée ou vapeur",
    "PUNCTURE": "Pneu crevé - roue de secours disponible",
    "PUNCTURE BOLTS": "Écrous ou boulons de roue manquants/cassés",
    "PUNCTURE FOAM": "Pneu crevé - kit mousse",
    "PUNCTURE MULTI": "Plusieurs pneus crevés",
    "PUNCTURE NS": "Pneu crevé - pas de roue de secours",
    "REPATRIATION": "Rapatriement du véhicule",
    "RTC": "Accident de la route",
    "SEAT BELT": "Défaut de ceinture",
    "SMELL": "Odeur ou fumées inconnues",
    "SMOKING": "Fumée à l'échappement",
    "STALLING": "Le moteur cale",
    "STEERING FAILURE": "Défaut de direction",
    "STEERING HEAVY": "Direction dure / assistance défaillante",
    "STEERING LOCK": "Blocage de direction ou barillet",
    "STOLEN": "Véhicule volé",
    "STUCK": "Véhicule bloqué",
    "SUSPENSION": "Suspension cassée",
    "TIMING BELT": "Courroie de distribution suspectée",
    "TRAILER": "Défaut remorque ou caravane",
    "TURBO": "Turbo défectueux",
    "VANDALISED": "Véhicule vandalisé",
    "WASHERS WIPERS": "Lave-glace ou essuie-glaces défectueux",
    "WHEEL": "Roue desserrée",
    "WINDOWS": "Vitre défectueuse",
    "WLO ORANGE": "Voyant orange",
    "WLO RED": "Voyant rouge"
  };
  symptomOptionTranslations.sv = {
    "OTHER": "Annat",
    "ALARM / IMMOBILISER": "Larm eller startspärr",
    "ALTERNATOR": "Misstänkt generatorfel",
    "AUTO GBOX": "Automatväxellåda",
    "BATTERY": "Urladdat batteri",
    "BATTERY LLO": "Urladdat batteri - lampor lämnade på",
    "BODY": "Kaross",
    "BRAKE NOISE": "Bromsljud",
    "BRAKE PEDAL": "Hydrauliskt bromsfel",
    "CLUTCH": "Kopplingsfel",
    "CLUTCH LINKAGE": "Kopplingspedal, vajer eller hydraulik",
    "CONVERTIBLE": "Fel på taksystem",
    "COOLANT LEAK": "Kylvätskeläckage",
    "CUT OUT": "Motorn stannade under körning",
    "DEMISTER": "Värme eller defroster fungerar inte",
    "DRIVEBELT": "Generator- eller styrrem fel",
    "DRIVESHAFT": "Drivaxel eller kardanaxel fel",
    "ENGINE": "Motorfel",
    "ENGINE NOISE": "Motorljud",
    "ENGINE OIL": "Oljeläckage",
    "EXHAUST": "Avgasrör",
    "FIRE": "Brandskada",
    "FLOOD": "Kört genom vatten",
    "FUEL ACCELERATOR": "Gaspedal eller gasvajer",
    "FUEL DIESEL": "Bränsle - diesel",
    "FUEL LEAK": "Bränsleläckage",
    "FUEL PETROL": "Bränsle - bensin",
    "GEAR LINKAGE": "Fel på växellänkage",
    "GEARBOX / DRIVE": "Manuell växellåda",
    "HANDBRAKE": "Handbromsfel",
    "HEAD GASKET": "Topplockspackning",
    "HORN": "Signalhorn",
    "HV CHARGE": "Elfordon laddar inte",
    "ILLNESS": "Förare sjuk eller skadad",
    "KEYS": "Nycklar tappade, stulna eller trasiga",
    "KEYS LOCK OUT": "Nycklar inlåsta i fordonet",
    "LIGHTS": "Fel på yttre belysning",
    "LOCKS": "Lås fastnat eller kan inte låsa/låsa upp",
    "LOP": "Motorn går ojämnt",
    "LOP WLO": "Motorn går ojämnt med varningslampa",
    "MISFUEL DIESEL": "Bensin i diesel",
    "MISFUEL OTHER": "Fel vätska eller bränsle",
    "MISFUEL PETROL": "Diesel i bensin",
    "NOISE": "Ljud under körning",
    "NON START DOK": "Ingen reaktion vid start",
    "NON START TONF": "Motorn går runt men startar inte",
    "OVERHEAT": "Hög temperatur eller ånga",
    "PUNCTURE": "Punktering - reservhjul finns",
    "PUNCTURE BOLTS": "Hjulmuttrar eller låsbultar saknas/trasiga",
    "PUNCTURE FOAM": "Punktering - skumkit",
    "PUNCTURE MULTI": "Flera punkterade däck",
    "PUNCTURE NS": "Punktering - inget reservhjul",
    "REPATRIATION": "Fordonsrepatriering",
    "RTC": "Trafikolycka",
    "SEAT BELT": "Fel på säkerhetsbälte",
    "SMELL": "Okänd lukt eller ångor",
    "SMOKING": "Rök från avgasrör",
    "STALLING": "Motorn stannar",
    "STEERING FAILURE": "Styrningsfel",
    "STEERING HEAVY": "Tung styrning / servostyrning fungerar inte",
    "STEERING LOCK": "Rattlås eller tändningslås",
    "STOLEN": "Fordon stulet",
    "STUCK": "Fordon fast",
    "SUSPENSION": "Trasig fjädring",
    "TIMING BELT": "Misstänkt kamremsfel",
    "TRAILER": "Fel på släp eller husvagn",
    "TURBO": "Turbofel",
    "VANDALISED": "Fordon vandaliserat",
    "WASHERS WIPERS": "Spolare eller vindrutetorkare fel",
    "WHEEL": "Hjul löst",
    "WINDOWS": "Fönsterfel",
    "WLO ORANGE": "Orange varningslampa",
    "WLO RED": "Röd varningslampa"
  };
  symptomOptionTranslations.nl = {
    "OTHER": "Overig",
    "ALARM / IMMOBILISER": "Alarm of startonderbreker",
    "ALTERNATOR": "Vermoedelijke dynamo-storing",
    "AUTO GBOX": "Automatische versnellingsbak",
    "BATTERY": "Lege accu",
    "BATTERY LLO": "Lege accu - verlichting aan laten staan",
    "BODY": "Carrosserie",
    "BRAKE NOISE": "Remgeluid",
    "BRAKE PEDAL": "Hydraulische remstoring",
    "CLUTCH": "Koppelingsstoring",
    "CLUTCH LINKAGE": "Koppelingspedaal, kabel of hydrauliek",
    "CONVERTIBLE": "Dak-systeem storing",
    "COOLANT LEAK": "Koelvloeistoflekkage",
    "CUT OUT": "Motor viel uit tijdens rijden",
    "DEMISTER": "Verwarming of ontwaseming werkt niet",
    "DRIVEBELT": "Dynamo- of stuurriem defect",
    "DRIVESHAFT": "Aandrijfas defect",
    "ENGINE": "Motorstoring",
    "ENGINE NOISE": "Geluid uit motor",
    "ENGINE OIL": "Olielekkage",
    "EXHAUST": "Uitlaat",
    "FIRE": "Brandschade",
    "FLOOD": "Door water gereden",
    "FUEL ACCELERATOR": "Gaspedaal of gaskabel",
    "FUEL DIESEL": "Brandstof - diesel",
    "FUEL LEAK": "Brandstoflekkage",
    "FUEL PETROL": "Brandstof - benzine",
    "GEAR LINKAGE": "Schakelmechanisme storing",
    "GEARBOX / DRIVE": "Handgeschakelde versnellingsbak",
    "HANDBRAKE": "Handrem defect",
    "HEAD GASKET": "Koppakking",
    "HORN": "Claxon",
    "HV CHARGE": "Elektrisch voertuig laadt niet",
    "ILLNESS": "Bestuurder ziek of gewond",
    "KEYS": "Sleutels verloren, gestolen of kapot",
    "KEYS LOCK OUT": "Sleutels in voertuig opgesloten",
    "LIGHTS": "Buitenverlichting defect",
    "LOCKS": "Slot vast of kan niet vergrendelen/ontgrendelen",
    "LOP": "Motor loopt onregelmatig",
    "LOP WLO": "Motor loopt onregelmatig met waarschuwingslampje",
    "MISFUEL DIESEL": "Benzine in diesel",
    "MISFUEL OTHER": "Verkeerde vloeistof of brandstof",
    "MISFUEL PETROL": "Diesel in benzine",
    "NOISE": "Geluid tijdens rijden",
    "NON START DOK": "Geen reactie bij starten",
    "NON START TONF": "Motor draait maar start niet",
    "OVERHEAT": "Hoge temperatuur of stoom",
    "PUNCTURE": "Lekke band - reservewiel beschikbaar",
    "PUNCTURE BOLTS": "Wielmoeren of slotbouten ontbreken/kapot",
    "PUNCTURE FOAM": "Lekke band - schuimkit",
    "PUNCTURE MULTI": "Meer dan een lekke band",
    "PUNCTURE NS": "Lekke band - geen reservewiel",
    "REPATRIATION": "Voertuig repatriering",
    "RTC": "Verkeersongeval",
    "SEAT BELT": "Gordelstoring",
    "SMELL": "Onbekende geur of dampen",
    "SMOKING": "Rook uit uitlaat",
    "STALLING": "Motor slaat af",
    "STEERING FAILURE": "Stuurinrichting defect",
    "STEERING HEAVY": "Zwaar sturen / stuurbekrachtiging werkt niet",
    "STEERING LOCK": "Stuurslot of contactslot",
    "STOLEN": "Voertuig gestolen",
    "STUCK": "Voertuig vast",
    "SUSPENSION": "Vering defect",
    "TIMING BELT": "Vermoedelijke distributieriem storing",
    "TRAILER": "Aanhanger of caravan defect",
    "TURBO": "Turbo defect",
    "VANDALISED": "Voertuig gevandaliseerd",
    "WASHERS WIPERS": "Ruitensproeier of ruitenwissers defect",
    "WHEEL": "Wiel los",
    "WINDOWS": "Raam defect",
    "WLO ORANGE": "Oranje waarschuwingslampje",
    "WLO RED": "Rood waarschuwingslampje"
  };

  function walk(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    nodes.forEach(translateTextNode);
    Array.prototype.forEach.call(document.querySelectorAll("input, button, option"), translateElement);
  }

  function translateSymptomOptions() {
    var symptomSelect = document.querySelector("#ctl00_main_uxSymptomCodeDdl");
    var symptomDictionary = symptomOptionTranslations[language] || symptomOptionTranslations[baseLanguage] || symptomOptionTranslations.en;
    if (!symptomSelect) {
      return;
    }

    Array.prototype.forEach.call(symptomSelect.options, function (option) {
      var translated = symptomDictionary[option.value] || symptomOptionTranslations.en[option.value];
      if (translated) {
        option.textContent = option.value + " - " + translated;
      }
    });
  }

  function translateCommonDropdownOptions() {
    var dropdownIds = [
      "ctl00_main_uxAccDdl",
      "ctl00_main_uxCmpDdl",
      "ctl00_main_uxSitesDdl",
      "ctl00_main_uxJobDateDdl",
      "ctl00_main_uxFtDdl",
      "ctl00_main_uxTtDdl",
      "ctl00_main_uxServiceDdl"
    ];

    dropdownIds.forEach(function (id) {
      var select = document.querySelector("#" + id);
      if (!select) {
        return;
      }

      Array.prototype.forEach.call(select.options, function (option) {
        var optionKey = dropdownTranslationKeys[clean(option.textContent)];
        if (optionKey && dropdownText[optionKey]) {
          option.textContent = dropdownText[optionKey];
        }
      });
    });
  }

  function hideFormRowsByLabel(labels) {
    var hiddenLabels = labels.map(function (label) {
      return clean(label).toLowerCase();
    });

    Array.prototype.forEach.call(document.querySelectorAll("td, th, label, span"), function (element) {
      var text = clean(element.textContent).toLowerCase();
      if (hiddenLabels.indexOf(text) === -1) {
        return;
      }

      var row = element.closest("tr");
      if (row) {
        row.style.display = "none";
        return;
      }

      var container = element.parentElement;
      if (container) {
        container.style.display = "none";
      }
    });
  }

  function relabelFormLabel(fromLabel, toLabel) {
    var target = clean(fromLabel).toLowerCase();

    Array.prototype.forEach.call(document.querySelectorAll("td, th, label, span"), function (element) {
      if (clean(element.textContent).toLowerCase() === target) {
        element.textContent = toLabel;
      }
    });
  }

  function markFormRowsByLabel(labels, className) {
    var matchedLabels = labels.map(function (label) {
      return clean(label).toLowerCase();
    });

    Array.prototype.forEach.call(document.querySelectorAll("td, th, label, span"), function (element) {
      var text = clean(element.textContent).toLowerCase();
      if (matchedLabels.indexOf(text) === -1) {
        return;
      }

      var row = element.closest("tr");
      if (row) {
        row.classList.add(className);
      }
    });
  }

  function defaultConfiguredAccount() {
    if (!defaultAccountName) {
      return;
    }

    var targetAccount = clean(defaultAccountName).toLowerCase();
    Array.prototype.forEach.call(document.querySelectorAll("select"), function (select) {
      var matchingOption = Array.prototype.find.call(select.options, function (option) {
        return clean(option.textContent).toLowerCase() === targetAccount;
      });

      if (matchingOption && select.value !== matchingOption.value) {
        select.value = matchingOption.value;
      }
    });
  }

  function defaultSite() {
    if (!defaultSiteName) {
      return;
    }

    var siteSelect = document.querySelector("#ctl00_main_uxSitesDdl");
    if (!siteSelect) {
      return;
    }

    var targetSite = clean(defaultSiteName).toLowerCase();
    var siteOption = Array.prototype.find.call(siteSelect.options, function (option) {
      return clean(option.textContent).toLowerCase() === targetSite;
    });

    if (siteOption) {
      siteSelect.value = siteOption.value;
    }
  }

  function defaultService() {
    if (!defaultServiceName) {
      return;
    }

    var serviceSelect = document.querySelector("#ctl00_main_uxServiceDdl");
    if (!serviceSelect) {
      return;
    }

    var targetService = clean(defaultServiceName).toLowerCase();
    var serviceOption = Array.prototype.find.call(serviceSelect.options, function (option) {
      return clean(option.textContent).toLowerCase() === targetService;
    });

    if (serviceOption) {
      serviceSelect.value = serviceOption.value;
      serviceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }

    var serviceRow = serviceSelect.closest("tr");
    if (serviceRow) {
      serviceRow.style.display = "none";
    }
  }

  function defaultOrderNumber() {
    var orderInput = document.querySelector("#ctl00_main_uxOrderNoTxt");
    if (!orderInput || clean(orderInput.value)) {
      return;
    }

    var now = new Date();
    var datePart = String(now.getFullYear()).slice(-2) +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0");
    var randomPart = String(Math.floor(1000 + Math.random() * 9000));
    orderInput.value = defaultOrderPrefix + datePart + randomPart;
  }

  function showOnlySendImagesInJobDetails() {
    var uploader = document.querySelector("#ctl00_main_uxUploaderDiv");
    if (!uploader) {
      return;
    }

    var uploadRow = uploader.closest("tr");
    var section = uploader.closest(".gf");
    if (!uploadRow || !section) {
      return;
    }

    section.classList.add("tse-job-details-images-only");
    uploadRow.classList.add("tse-keep-send-images");
  }

  function addLocationHelper() {
    var locationInput = document.querySelector("#ctl00_main_uxLocDetails");
    if (!locationInput || document.querySelector(".tse-location-tools")) {
      return;
    }

    var tools = document.createElement("div");
    tools.className = "tse-location-tools";

    var button = document.createElement("button");
    button.type = "button";
    button.className = "tse-location-button";
    button.textContent = locationText.button;

    var status = document.createElement("div");
    status.className = "tse-location-status";
    status.setAttribute("aria-live", "polite");

    tools.appendChild(button);
    tools.appendChild(status);
    locationInput.parentNode.insertBefore(tools, locationInput);

    button.addEventListener("click", function () {
      if (!navigator.geolocation) {
        status.textContent = locationText.unavailable;
        return;
      }

      button.disabled = true;
      status.textContent = locationText.loading;

      navigator.geolocation.getCurrentPosition(
        function (position) {
          var lat = position.coords.latitude;
          var lng = position.coords.longitude;
          fetch("/api/what3words?lat=" + encodeURIComponent(lat) + "&lng=" + encodeURIComponent(lng) + "&language=" + encodeURIComponent(language))
            .then(function (response) {
              return response.json().then(function (body) {
                return { ok: response.ok, body: body };
              });
            })
            .then(function (result) {
              var gpsLine = "GPS: " + lat.toFixed(6) + ", " + lng.toFixed(6);
              if (result.ok && result.body.words) {
                var lines = ["///" + result.body.words, gpsLine];
                if (result.body.nearestPlace) {
                  lines.splice(1, 0, "Near: " + result.body.nearestPlace);
                }
                if (result.body.map) {
                  lines.push(result.body.map);
                }
                locationInput.value = mergeLocationText(locationInput.value, lines.join("\\n"));
                status.textContent = locationText.found;
                return;
              }

              locationInput.value = mergeLocationText(locationInput.value, gpsLine);
              status.textContent = result.body && result.body.error ? locationText.notConfigured : locationText.unavailable;
            })
            .catch(function () {
              locationInput.value = mergeLocationText(locationInput.value, "GPS: " + lat.toFixed(6) + ", " + lng.toFixed(6));
              status.textContent = locationText.unavailable;
            })
            .finally(function () {
              button.disabled = false;
            });
        },
        function () {
          button.disabled = false;
          status.textContent = locationText.denied;
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
      );
    });
  }

  function mergeLocationText(existing, addition) {
    var current = clean(existing);
    if (!current) {
      return addition;
    }
    return current + "\\n" + addition;
  }

  function addSupportPhone() {
    if (document.querySelector(".tse-support")) {
      return;
    }

    var link = document.createElement("a");
    link.className = "tse-support";
    link.href = "https://wa.me/" + supportWhatsappNumber.replace(/\D/g, "");
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "Open WhatsApp";
    link.setAttribute("aria-label", "Message Travel Support Europe on WhatsApp " + supportWhatsappNumber);
    link.innerHTML = '<span class="tse-support-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.46-2.39-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35ZM12.05 21.79h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.89 9.89-9.89a9.82 9.82 0 0 1 6.99 2.9 9.82 9.82 0 0 1 2.89 6.99c0 5.45-4.44 9.89-9.88 9.89Zm8.41-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.31-1.65a11.88 11.88 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.89a11.82 11.82 0 0 0-3.49-8.42Z"/></svg></span><span class="tse-support-text">Support</span>';
    document.body.appendChild(link);
  }

  relabelFormLabel("Auth. Code:", "TSE Case No");
  markFormRowsByLabel(["TSE Case No"], "tse-keep-case-number");
  hideFormRowsByLabel(["Order No:", "Fleet No:"]);

  walk(document.body);
  translateSymptomOptions();

  defaultConfiguredAccount();
  defaultSite();
  defaultService();
  translateCommonDropdownOptions();
  defaultOrderNumber();
  showOnlySendImagesInJobDetails();
  addLocationHelper();
  addSupportPhone();
})();
</script>`;

  if (bookingHtml.includes("</body>")) {
    return bookingHtml.replace("</body>", `${script}</body>`);
  }

  return `${bookingHtml}${script}`;
}

server.listen(port, host, () => {
  console.log(`Travel Support Europe booking app running on ${host}:${port}`);
});
