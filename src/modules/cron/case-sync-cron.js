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
    const dbCases = await getDistrictCourtCasesFromDb();

    //Iterate through the cases and update one by one
    for(const dcCase of dbCases) {
      console.log("Processing case sync cron for case: " + dcCase.id);
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
              console.log("Required fields missing - caseNo:", params.caseNo, "cino:", params.cino, "courtCode:", params.courtCode);               continue;
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

            const now = new Date();
            const existingDate = dcCase.nextHearingDate;
            const newDateParsed = parseCourtDate(newData.result.case_status.next_hearing_date);

            const shouldUpdateHearingDate =
            !existingDate ||
            (
              newDateParsed &&
              (
                toDate(existingDate) <= now ||
                toDate(newDateParsed) >= toDate(existingDate)
              )
            );


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
                nextHearingDate: shouldUpdateHearingDate ? newDateParsed : existingDate,
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
            if (shouldUpdateHearingDate && newDateParsed && newDateParsed !== dcCase.nextHearingDate) {
                createNotification(dcCase.owner, dcCase.id, newDateRaw, dcCase)
                .catch(err => console.error(`Notification creation failed for case ${dcCase.id}:`, err));
            }
        } catch (err) {
            console.log("Some error occurred: ", err.message);
        }
    }
}

const toDate = (str) => {
    if (!str) return null;
    const [dd, mm, yyyy] = str.split("/");
    return new Date(`${yyyy}-${mm}-${dd}`);
};

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

async function getDistrictCourtCasesFromDb() {
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
    const docId = "lwf7OYs6PGmEZ2JqwIYZ"; // your test doc ID
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

async function createNotification(ownerId, caseId, nextHearingDate, dcCase) {
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
    console.log(hearingDate);

    // Reminder  → same day at 8:00 AM
    const reminder1 = new Date(hearingDate);
    reminder1.setHours(8, 0, 0, 0); // same day 8 AM

    const reminder2 = new Date(hearingDate);
    reminder2.setHours(18, 0, 0, 0);

    // Store notification in DB
    const event1 = await db.collection("eventReminders").add({
      "caseId" : caseId,
      "caseNo" : `${dcCase.caseNo}`,
      "createdAt" : new Date(),
      "eventTitle" : `${dcCase.petitionerName} VS ${dcCase.respondentName}`,
      "recipientId" : ownerId,
      "reminderTime" : reminder1,
      "scheduledBy" : ownerId,
      "status" : "scheduled"
    });

    const event2 = await db.collection("eventReminders").add({
      "caseId" : caseId,
      "caseNo" : `${dcCase.caseNo}`,
      "createdAt" : new Date(),
      "eventTitle" : `Update Next Hearing: ${dcCase.petitionerName} VS ${dcCase.respondentName}`,
      "recipientId" : ownerId,
      "reminderTime" : reminder2,
      "scheduledBy" : ownerId,
      "status" : "scheduled"
    });


    console.log(`Notification created for case: ${caseId}, owner: ${ownerId}`);
    console.log("Notification created with ID: " + event1.id + " " + event2.id);
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

/*async function sendDueNotifications() {
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

async function sendDueNotificationForDoc() {
  try {
    const docSnap = await db.collection("notificationLogs").doc("619z64s6i5XWzqtVavli").get();

    if (!docSnap.exists) {
      console.log("No notification found for doc:", docId);
      return;
    }

    const data = docSnap.data();

    // Decide which reminder window we are in so we can avoid resending
    // the same one. reminder1 = day-before 8AM, reminder2 = day-of 8AM.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const hearing = data.nextHearingDate?.toDate
      ? data.nextHearingDate.toDate()
      : new Date(data.nextHearingDate);

    const isSameDay =
      hearing >= today &&
      hearing < new Date(today.getTime() + 24 * 60 * 60 * 1000);

    const reminderField = isSameDay
      ? "reminder2Sent"
      : "reminder1Sent";

    if (data[reminderField]) {
      console.log("Reminder already sent for: 619z64s6i5XWzqtVavli");
      return;
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
      console.log(`No FCM tokens for doc: ${docId}`);
      return;
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
              `FCM failure for doc ${docId} token ...${tokens[idx].slice(-6)}:`,
              resp.error?.code,
              resp.error?.message
            );
          }
        });
      }

      if (response.successCount > 0) {
        await docSnap.ref.update({ [reminderField]: true });
      }
    } catch (err) {
      console.error("FCM send error for doc:", docId, err);
    }

  } catch (err) {
    console.error("Error in sendDueNotificationForDoc:", err);
    throw err;
  }
}

async function sendMorningNotifications() {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    let reminders = await db.collection("eventReminders")
                          .where("nextHearingDate", ">=", startOfDay)
                          .where("nextHearingDate", "<=", endOfDay)
                          .get();


    if (reminders.empty) {
      console.log("No notifications found for today");
      return;
    }

    for (let reminderDoc of reminders.docs) {
      let reminder = reminderDoc.data();

      // Transaction: atomically claim the reminder
      let claimed = false;
      try {
        await db.runTransaction(async (t) => {
          const fresh = await t.get(reminderDoc.ref);

          if (fresh.data().event1.reminderSent) {
            claimed = false; // already claimed by another cron
            return;
          }

          // Mark as sent atomically so no other cron can claim it
          t.update(reminderDoc.ref, { "event1.reminderSent": true, sentAt: new Date() });
          claimed = true;
        });
      } catch (err) {
        console.error("Transaction failed for doc:", reminderDoc.id, err);
        continue;
      }

      if (!claimed) {
        console.log("Reminder for case " + reminder.caseId + " already sent.");
        continue;
      }
      // End of transaction

      try {
        let ownerSnap = await db.collection("lawyers").doc(reminder.userId).get();
        if (!ownerSnap.exists) {
          ownerSnap = await db.collection("client").doc(reminder.userId).get();
        }
        const tokens = ownerSnap.exists
          ? normalizeFcmTokens(ownerSnap.data().fcmTokens)
          : normalizeFcmTokens(reminder.fcmTokens);

        if (!tokens.length) {
          console.log(`No FCM tokens for doc: ${reminderDoc.id}`);
          continue;
        }

        const notification = {
          title: reminder.event1.description || "Hearing Reminder",
          body: reminder.event1.title || "You have an upcoming hearing",
        };

        const messages = tokens.map((token) =>
          withPlatformConfig({ token, notification })
        );

        const response = await admin.messaging().sendEach(messages);
        console.log(
          `Notification sent for case ${reminder.caseId} | success: ${response.successCount}, failure: ${response.failureCount}`
        );
        if (response.failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              console.error(
                `FCM failure for doc ${reminderDoc.id} token ...${tokens[idx].slice(-6)}:`,
                resp.error?.code,
                resp.error?.message
              );
            }
          });
        }

        // Note: we already set reminderSent: true in the transaction above
        // so we don't update it again here

        const eventNotification = {
          "userId": reminder.userId,
          "caseId": reminder.caseId
        };
        await db.collection("notificationLogs").add(eventNotification);
      } catch (err) {
        // FCM failed — roll back the flag so another cron can retry
        await reminderDoc.ref.update({ reminderSent: false, sentAt: null });
        console.error("FCM send error for doc:", reminderDoc.id, err);
      }
    }
  } catch (err) {
    console.error("Error in sendDueNotifications:", err);
    throw err;
  }
}

async function sendEveningNotifications() {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    let reminders = await db.collection("eventReminders")
                          .where("nextHearingDate", ">=", startOfDay)
                          .where("nextHearingDate", "<=", endOfDay)
                          .get();


    if (reminders.empty) {
      console.log("No notifications found for today");
      return;
    }

    for (let reminderDoc of reminders.docs) {
      let reminder = reminderDoc.data();

      // Transaction: atomically claim the reminder
      let claimed = false;
      try {
        await db.runTransaction(async (t) => {
          const fresh = await t.get(reminderDoc.ref);

          if (fresh.data().event2.reminderSent) {
            claimed = false; // already claimed by another cron
            return;
          }

          // Mark as sent atomically so no other cron can claim it
          t.update(reminderDoc.ref, { "event2.reminderSent": true, sentAt: new Date() });
          claimed = true;
        });
      } catch (err) {
        console.error("Transaction failed for doc:", reminderDoc.id, err);
        continue;
      }

      if (!claimed) {
        console.log("Reminder for case " + reminder.caseId + " already sent.");
        continue;
      }
      // End of transaction

      let ownerSnap = await db.collection("lawyers").doc(reminder.userId).get();
      if (!ownerSnap.exists) {
        ownerSnap = await db.collection("client").doc(reminder.userId).get();
      }
      const tokens = ownerSnap.exists
        ? normalizeFcmTokens(ownerSnap.data().fcmTokens)
        : normalizeFcmTokens(reminder.fcmTokens);

      if (!tokens.length) {
        console.log(`No FCM tokens for doc: ${reminderDoc.id}`);
        continue;
      }

      const notification = {
        title: reminder.event2.eventReminders.eventTitle || "Hearing Reminder",
        body: reminder.event2.title || "You have an upcoming hearing",
      };

      const messages = tokens.map((token) =>
        withPlatformConfig({ token, notification })
      );

      try {
        const response = await admin.messaging().sendEach(messages);
        console.log(
          `Notification sent for case ${reminder.caseId} | success: ${response.successCount}, failure: ${response.failureCount}`
        );
        if (response.failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              console.error(
                `FCM failure for doc ${reminderDoc.id} token ...${tokens[idx].slice(-6)}:`,
                resp.error?.code,
                resp.error?.message
              );
            }
          });
        }

        // Note: we already set reminderSent: true in the transaction above
        // so we don't update it again here

        const eventNotification = {
          "userId": reminder.userId,
          "caseId": reminder.caseId
        };
        await db.collection("notificationLogs").add(eventNotification);
      } catch (err) {
        // FCM failed — roll back the flag so another cron can retry
        await reminderDoc.ref.update({ reminderSent: false, sentAt: null });
        console.error("FCM send error for doc:", reminderDoc.id, err);
      }
    }
  } catch (err) {
    console.error("Error in sendDueNotifications:", err);
    throw err;
  }
}*/

module.exports = {
    caseSyncCronJob,
    //sendDueNotifications,
}