const { initSession } = require("../portal/portal.service")
const { getSession } = require("../../shared/store/sessionStore")
const { db, admin } = require("../../config/firebase-admin-config")
const {
  fetchViewHistory,
} = require("../searches/party-name/party-name.service");

const { sanitizeCaseDetailResponse,
    attachOrderPdfProxy,
    buildCaseDetailSections,
} = require("../searches/party-name/party-name.controller")

const { parseCaseDetail } = require("../searches/party-name/parsers");


async function caseSyncCronJob() {
    //Fetch the session
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const session = getSession(sessionId);
    await initSession(session);

    const cookies = await session.jar.getCookies("https://services.ecourts.gov.in/ecourtindia_v6/");

    let JSESSIONID, SERVICES_SESSID;
    cookies.forEach(cookie => {
    if (cookie.key === "JSESSION") JSESSIONID = cookie.value;
    if (cookie.key === "SERVICES_SESSID") SERVICES_SESSID = cookie.value;
    });

    //Get cases from firebase
    const dbCases = await getHighCourtCasesFromDb();

    //Iterate through the cases and update one by one
    for(const dcCase of dbCases) {
        //Fetch updated data from gov api
        try {
            let CASE_NO = dcCase.payload?.detailsPayload?.caseNo;
            let COURT_CODE = dcCase.payload?.detailsPayload?.courtCode;
            let COURT_COMPLEX_CODE = dcCase.payload?.detailsPayload?.complexCode;
            let STATE_CODE = dcCase.payload?.detailsPayload?.stateCode;
            let CINO = dcCase.payload?.detailsPayload?.cino;
            let DIST_CODE = dcCase.payload?.detailsPayload?.distCode;
            let SEARCH_FLAG = dcCase.payload?.detailsPayload?.searchFlag;
            let SEARCH_BY = dcCase.payload?.detailsPayload?.searchBy;
            const params = {
                caseNo: CASE_NO,
                cino: CINO,
                courtCode: COURT_CODE,
                hideparty: "",
                searchFlag: SEARCH_FLAG,
                stateCode: STATE_CODE,
                distCode: DIST_CODE,
                complexCode: COURT_COMPLEX_CODE,
                searchBy: SEARCH_BY
            };

            if (!params.caseNo || !params.cino || !params.courtCode) {
                console.log("Required fields missing");
                continue;
            }

            const html = await fetchViewHistory(session, params);
            const caseDetailResult = sanitizeCaseDetailResponse(
                attachOrderPdfProxy(parseCaseDetail(html), sessionId),
            );

            const newData = {
                message: "Case details fetched",
                result: buildCaseDetailSections(caseDetailResult),
                rawHtml: html,
            };

            const allPetitioners = normalizePetitionerEntries(newData.result.petitioner_and_advocate.entries);
            const allRespondents = normalizeRespondentEntries(newData.result.respondent_and_advocate.entries);

            //Update the db case with new updated data
            const updatedCase = {
                filingNumber: newData.result.case_details.filing_number,
                caseType: newData.result.case_details.case_type,
                caseFiledDate: newData.result.case_details.filing_date,
                registrationNumber: newData.result.case_details.registration_number,
                registrationDate: newData.result.case_details.registration_date,
                cnrNumber: newData.result.case_details.cnr_number,
                courtName: newData.result.case_status.court_number_and_judge || newData.result.court_header.court_name,
                firstHearingDate: parseCourtDate(newData.result.case_status.first_hearing_date),
                nextHearingDate: parseCourtDate(newData.result.case_status.next_hearing_date),
                decisionDate: parseCourtDate(newData.result.case_status.decision_date),
                stageOfCase: newData.result.case_status.case_stage,
                allPetitioners, 
                allRespondents,   
                allActs: newData.result.acts,
                iaStatus: newData.result.ia_status,
                caseHistory: newData.result.case_history,
                interimOrders: newData.result.interim_orders,
                finalOrders: newData.result.final_orders,
                connectedCases: newData.result.connected_cases,
                status: newData.result.case_status.case_status,
                lastSyncedAt: new Date()
            };

            //Merge update into Firestore
            await db.collection("pending").doc(dcCase.id).set(updatedCase, { merge: true });

            console.log("Case updated in Firestore: ", dcCase.id);

            const newDateRaw = newData.result.case_status.next_hearing_date;
            const newDateParsed = parseCourtDate(newDateRaw);
            if (newDateParsed && newDateParsed !== dcCase.nextHearingDate) {
                await createNotification(dcCase.owner, dcCase.id, newDateRaw);
            }
        } catch (err) {
            console.log("Some error occurred: ", err.message);
        }
    }
}

function parseCourtDate(dateStr) {
    if (!dateStr || typeof dateStr !== "string") return null;

    // Example input: "09th March 2026"
    const cleaned = dateStr.replace(/(\d+)(st|nd|rd|th)/, "$1"); 
    const parts = cleaned.split(" ");

    if (parts.length !== 3) return null;

    let [day, month, year] = parts;

    const monthMap = {
        january: "01",
        february: "02",
        march: "03",
        april: "04",
        may: "05",
        june: "06",
        july: "07",
        august: "08",
        september: "09",
        october: "10",
        november: "11",
        december: "12"
    };

    const monthNum = monthMap[month.toLowerCase()];
    if (!monthNum) return null;

    day = day.padStart(2, "0");

    return `${day}/${monthNum}/${year}`;
}

function normalizePetitionerEntries(entries) {
  return entries.map((entry) => {
    let name = entry;
    let advocate = "";

    if (entry.toLowerCase().startsWith("advocate-")) {
      advocate = entry.replace(/Advocate- /i, "").trim();
      name = "";
    } else {
      name = entry.replace(/^\d+\)\s*/, "").trim();
    }

    return { name, advocate };
  });
}

function normalizeRespondentEntries(entries) {
  return entries.map((entry) => {
    const name = entry.replace(/^\d+\)\s*/, "").trim();
    return { name, advocate: "" };
  });
}

async function getHighCourtCasesFromDb() {
  try {
    const casesRef = db.collection("pending");

    // Admin SDK query
    const querySnapshot = await casesRef
      .where("payload.caseexportedfrom", "==", "DistrictCourt")
      .get();

    const cases = [];
    querySnapshot.forEach((doc) => {
      cases.push({ id: doc.id, ...doc.data(), collection: "pending" });
    });
    return cases;
  } catch (err) {
    console.error("Error fetching cases:", err);
    return [];
  }
}

/*async function getSingleCaseFromDb() {
  try {
    const docId = "A27UYPwkPqZo88FDVdtk"; // your test doc ID
    const docSnap = await db.collection("pending").doc(docId).get();

    if (!docSnap.exists) {
      console.log("No document found");
      return [];
    }

    const data = docSnap.data();

    return [
      {
        id: docSnap.id,
        ...data,
        caseNo: data.payload?.detailsPayload?.caseNo,
        cino: data.payload?.detailsPayload?.cino,
        courtCode: data.payload?.detailsPayload?.courtCode,
        complexCode: data.payload?.detailsPayload?.complexCode,
        stateCode: data.payload?.detailsPayload?.stateCode,
        distCode: data.payload?.detailsPayload?.distCode,
        searchFlag: data.payload?.detailsPayload?.searchFlag,
        searchBy: data.payload?.detailsPayload?.searchBy,
      }
    ];

  } catch (err) {
    console.error("Error fetching case:", err);
    return [];
  }
}*/

function parseNextHearingDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;

  // Match "14th May 2026" or similar
  const match = dateStr.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = new Date(`${match[2]} 1, 2000`).getMonth(); // convert month name to month index
    const year = parseInt(match[3], 10);
    return new Date(year, month, day);
  }

  // If not matching expected format
  return null;
}

async function createNotification(ownerId, caseId, nextHearingDate) {
  try {
    // Fetch FCM tokens of owner. JuridentPortal stores users in `lawyers`
    // and `client` (singular) — not `clients`.
    const lawyerDoc = await db.collection("lawyers").doc(ownerId).get();
    const clientDoc = await db.collection("client").doc(ownerId).get();
    if (!lawyerDoc.exists && !clientDoc.exists) {
      console.log("Owner not found for case:", caseId);
      return;
    }

    const ownerDoc = lawyerDoc.exists ? lawyerDoc : clientDoc;

    // fcmTokens are stored as `{ token, platform, updatedAt }` objects by
    // fcmService.js. Some legacy entries may be raw strings.
    const fcmTokens = normalizeFcmTokens(ownerDoc.data().fcmTokens);

    // Compute reminder times
    const hearingDate = parseNextHearingDate(nextHearingDate);

    const reminder1 = new Date(hearingDate.getTime() - 24*60*60*1000);
    reminder1.setHours(8, 0, 0, 0);

    // Reminder 2 → same day at 8:00 AM
    const reminder2 = new Date(hearingDate);
    reminder2.setHours(8, 0, 0, 0); // same day 9 AM

    // Store notification in DB
    const docRef = await db.collection("notificationLogs").add({
      userId: ownerId,
      caseId,
      title: "Hearing Reminder",
      message: `Your hearing is scheduled for ${nextHearingDate}`,
      nextHearingDate: hearingDate,  // <--- store as Date
      reminder1: new Date(hearingDate.getTime() - 24*60*60*1000),
      reminder2: new Date(hearingDate),
      fcmTokens,
      reminder1Sent: false,
      reminder2Sent: false,
      createdAt: new Date(),
    });

    console.log(`Notification created for case: ${caseId}, owner: ${ownerId}`);
    console.log(`Notification created with ID: ${docRef.id}`);
  } catch (err) {
    console.error("Error creating notification:", err);
  }
}

function normalizeFcmTokens(rawTokens) {
  if (!Array.isArray(rawTokens)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of rawTokens) {
    const t = typeof entry === "string" ? entry : entry?.token;
    if (!t || typeof t !== "string") continue;
    if (seen.has(t)) continue;
    seen.add(t);
    result.push(t);
  }
  return result;
}

function withPlatformConfig(message) {
  return {
    ...message,
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: "default", badge: 1 } },
      ...(message.apns || {}),
    },
    android: {
      priority: "high",
      notification: {
        channelId: "high_importance_channel",
        sound: "notification_sound",
      },
      ...(message.android || {}),
    },
  };
}

async function sendDueNotifications() {
  try {
    // Start of today (00:00) and end of tomorrow (23:59) in local timezone.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const endOfTomorrow = new Date(today);
    endOfTomorrow.setDate(today.getDate() + 1);
    endOfTomorrow.setHours(23, 59, 59, 999);

    console.log("Checking notifications between:", today, "and", endOfTomorrow);

    const snapshot = await db.collection("notificationLogs")
      .where("nextHearingDate", ">=", today)
      .where("nextHearingDate", "<=", endOfTomorrow)
      .get();

    if (snapshot.empty) {
      console.log("No notifications found for today/tomorrow");
      return;
    }

    for (const doc of snapshot.docs) {
      const data = doc.data();

      // Decide which reminder window we are in so we can avoid resending
      // the same one. reminder1 = day-before 8AM, reminder2 = day-of 8AM.
      const hearing = data.nextHearingDate?.toDate
        ? data.nextHearingDate.toDate()
        : new Date(data.nextHearingDate);
      const isSameDay = hearing >= today && hearing < new Date(today.getTime() + 24*60*60*1000);
      const reminderField = isSameDay ? "reminder2Sent" : "reminder1Sent";

      if (data[reminderField]) {
        continue;
      }

      // Re-fetch tokens at send time — they rotate and the stored snapshot
      // can be stale by hours.
      let ownerSnap = await db.collection("lawyers").doc(data.userId).get();
      if (!ownerSnap.exists) {
        ownerSnap = await db.collection("client").doc(data.userId).get();
      }
      const tokens = ownerSnap.exists
        ? normalizeFcmTokens(ownerSnap.data().fcmTokens)
        : normalizeFcmTokens(data.fcmTokens);

      if (!tokens.length) {
        console.log(`No FCM tokens for doc: ${doc.id}`);
        continue;
      }

      const notification = {
        title: data.title || "Hearing Reminder",
        body: data.message || "You have an upcoming hearing",
      };

      const messages = tokens.map((token) =>
        withPlatformConfig({ token, notification })
      );

      try {
        const response = await admin.messaging().sendEach(messages);
        console.log(
          `Notification sent for case ${data.caseId} | success: ${response.successCount}, failure: ${response.failureCount}`
        );
        if (response.failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              console.error(
                `FCM failure for doc ${doc.id} token ...${tokens[idx].slice(-6)}:`,
                resp.error?.code,
                resp.error?.message
              );
            }
          });
        }
        if (response.successCount > 0) {
          await doc.ref.update({ [reminderField]: true });
        }
      } catch (err) {
        console.error("FCM send error for doc:", doc.id, err);
      }
    }

  } catch (err) {
    console.error("Error in sendDueNotifications:", err);
    throw err;
  }
}

module.exports = {
    caseSyncCronJob,
    sendDueNotifications,
}