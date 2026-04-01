"use strict";

const {
  coerceBoolean,
  firstDefined,
  sendJsonSuccess,
} = require("./utils/common");
const { MESSAGES } = require("./party-name.constants");
const {
  buildBusinessDetailQueryParams,
  buildCaptchaFragment,
  buildPartySearchSuccessResponse,
  fetchCaptchaPayload,
  fetchDisplayPdf,
  fetchDisplayPdfBinary,
  fetchIABusiness,
  fetchViewBusiness,
  fetchViewHistory,
  normalizePartySearchResponse,
  parsePartyNameResults,
  postWithRetry,
} = require("./party-name.service");
const { parseCaseDetail } = require("./parsers");
const { getSession } = require("./store/sessionStore");

function buildOrderPdfProxy(sessionId, pdfParams) {
  if (!sessionId || !pdfParams?.normal_v || !pdfParams?.case_val || !pdfParams?.court_code || !pdfParams?.filename) {
    return "";
  }

  const query = new URLSearchParams({
    sessionId: String(sessionId),
    normal_v: String(pdfParams.normal_v),
    case_val: String(pdfParams.case_val),
    court_code: String(pdfParams.court_code),
    filename: String(pdfParams.filename),
    appFlag: String(firstDefined(pdfParams.appFlag, pdfParams.app_flag, "")),
  });

  return `/api/partyname/order-pdf?${query.toString()}`;
}

function attachOrderPdfProxy(caseDetail, sessionId) {
  if (!caseDetail) {
    return caseDetail;
  }

  const attachToOrders = (orders) => {
    if (!Array.isArray(orders)) return orders;
    return orders.map((order) => {
      if (!order?.pdf_params) return order;
      return {
        ...order,
        pdfProxy: buildOrderPdfProxy(sessionId, order.pdf_params),
      };
    });
  };

  caseDetail.interim_orders = attachToOrders(caseDetail.interim_orders);
  caseDetail.final_orders = attachToOrders(caseDetail.final_orders);

  return caseDetail;
}

function sanitizeCaseDetailResponse(caseDetail) {
  if (!caseDetail || typeof caseDetail !== "object") {
    return caseDetail;
  }

  const sanitizeOrders = (orders) => {
    if (!Array.isArray(orders)) return orders;
    return orders.map((order) => {
      if (!order || typeof order !== "object") return order;
      const { pdf_params, order_onclick, order_href, ...rest } = order;
      return rest;
    });
  };

  const sanitizeHistory = (history) => {
    if (!Array.isArray(history)) return history;
    return history.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const { business_on_date_onclick, ...rest } = entry;
      return rest;
    });
  };

  const sanitizeIaStatus = (iaStatus) => {
    if (!Array.isArray(iaStatus)) return iaStatus;
    return iaStatus.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const { ia_onclick, ...rest } = entry;
      return rest;
    });
  };

  return {
    ...caseDetail,
    ia_status: sanitizeIaStatus(caseDetail.ia_status),
    history_of_case_hearing: sanitizeHistory(caseDetail.history_of_case_hearing),
    interim_orders: sanitizeOrders(caseDetail.interim_orders),
    final_orders: sanitizeOrders(caseDetail.final_orders),
  };
}

function buildCaseDetailSections(caseDetail) {
  const safe = caseDetail || {};

  return {
    court_header: {
      court_name: safe.court_name || "",
    },
    case_details: {
      case_type: safe.case_type || "",
      filing_number: safe.filing_number || "",
      filing_date: safe.filing_date || "",
      registration_number: safe.registration_number || "",
      registration_date: safe.registration_date || "",
      cnr_number: safe.cnr_number || "",
      e_filing_number: firstDefined(safe.e_filing_number, safe.efiling_number, ""),
      e_filing_date: firstDefined(safe.e_filing_date, safe.efiling_date, ""),
    },
    case_status: {
      first_hearing_date: safe.first_hearing_date || "",
      decision_date: safe.decision_date || "",
      next_hearing_date: safe.next_hearing_date || "",
      case_status: safe.case_status || "",
      nature_of_disposal: safe.nature_of_disposal || "",
      case_stage: safe.case_stage || "",
      court_number_and_judge: safe.court_number_and_judge || "",
    },
    petitioner_and_advocate: {
      entries: Array.isArray(safe.petitioners) ? safe.petitioners : [],
    },
    respondent_and_advocate: {
      entries: Array.isArray(safe.respondents) ? safe.respondents : [],
    },
    acts: Array.isArray(safe.acts) ? safe.acts : [],
    ia_status: Array.isArray(safe.ia_status) ? safe.ia_status : [],
    case_history: Array.isArray(safe.history_of_case_hearing)
      ? safe.history_of_case_hearing
      : [],
    interim_orders: Array.isArray(safe.interim_orders) ? safe.interim_orders : [],
    final_orders: Array.isArray(safe.final_orders) ? safe.final_orders : [],
    connected_cases: Array.isArray(safe.connected_cases) ? safe.connected_cases : [],
  };
}

async function caseData(req, res) {
  const { sessionId, rgyearP, stateCode, distCode, estCode } = req.body;
  const petresName = firstDefined(req.body.petresName, req.body.petres_name);
  const caseStatus = firstDefined(req.body.caseStatus, req.body.case_status, "Pending");
  const captchaCode = firstDefined(req.body.captchaCode, req.body.fcaptcha_code);
  const courtComplexCode = firstDefined(
    req.body.courtComplexCode,
    req.body.court_complex_code,
  );
  const fetchDetails = coerceBoolean(req.body.fetchDetails, false);
  const fetchIABusinessFlag = coerceBoolean(req.body.fetchIABusiness, false);
  const fetchBusinessFlag = coerceBoolean(req.body.fetchBusiness, false);
  const fetchPdf = coerceBoolean(req.body.fetchPdf, false);

  if (!sessionId || !petresName || !captchaCode) {
    return res.status(400).json({
      success: false,
      status: 0,
      error: MESSAGES.MISSING_CASE_DATA_FIELDS,
    });
  }

  try {
    const session = getSession(sessionId);
    const resolvedState = stateCode || session.stateCode;
    const resolvedDist = distCode || session.distCode;
    const resolvedComplex = courtComplexCode || session.complexCode;
    const resolvedEst = estCode || session.estCode || "null";

    if (!resolvedState || !resolvedDist || !resolvedComplex) {
      return res.status(400).json({
        success: false,
        status: 0,
        error: MESSAGES.COURT_DETAILS_NOT_SET,
      });
    }

    let layer1Data;
    try {
      layer1Data = await postWithRetry(session, "casestatus/submitPartyName", {
        petres_name: petresName,
        rgyearP: rgyearP || "",
        case_status: caseStatus || "Pending",
        fcaptcha_code: captchaCode,
        state_code: resolvedState,
        dist_code: resolvedDist,
        court_complex_code: resolvedComplex,
        est_code: resolvedEst,
      });
    } catch (err) {
      let nextCaptcha = null;
      try {
        nextCaptcha = await fetchCaptchaPayload(session, { warm: true });
      } catch (_captchaErr) {
        nextCaptcha = null;
      }
      const statusCode = err.message === "Invalid CAPTCHA" ? 422 : 500;
      return res.status(statusCode).json({
        success: false,
        status: 0,
        error: err.message,
        nextCaptcha,
      });
    }

    const normalizedSearch = normalizePartySearchResponse(layer1Data);
    const layer1Html =
      normalizedSearch.html ||
      (typeof normalizedSearch.raw?.party_data === "string"
        ? normalizedSearch.raw.party_data
        : "");

    let nextCaptcha = null;
    try {
      nextCaptcha = await fetchCaptchaPayload(session, { warm: true });
    } catch (_captchaErr) {
      nextCaptcha = null;
    }

    const responseCaptchaFragment =
      normalizedSearch.divCaptcha || buildCaptchaFragment(nextCaptcha);

    if (!layer1Html && normalizedSearch.upstreamStatus !== 1) {
      return res.status(422).json({
        success: false,
        status: 0,
        error: MESSAGES.EMPTY_SEARCH_RESPONSE,
        nextCaptcha,
      });
    }

    if (!layer1Html) {
      return res.status(422).json({
        success: false,
        status: 0,
        error: MESSAGES.EMPTY_PARTY_DATA_RESPONSE,
        nextCaptcha,
      });
    }

    const { cases, metadata, courtBreakdown } = parsePartyNameResults(layer1Html);

    if (!fetchDetails) {
      return sendJsonSuccess(
        res,
        buildPartySearchSuccessResponse({
          normalizedSearch,
          layer1Html,
          responseCaptchaFragment,
          nextCaptcha,
          cases,
          metadata,
          courtBreakdown,
          resolvedState,
          resolvedDist,
          resolvedComplex,
        }),
      );
    }

    const enrichedCases = [];
    for (const c of cases) {
      const vd = c.viewDetails;
      if (!vd || !vd.caseNo) {
        enrichedCases.push(c);
        continue;
      }

      let caseDetail = {};
      try {
        const detailHtml = await fetchViewHistory(session, {
          caseNo: vd.caseNo,
          cino: vd.cino,
          courtCode: vd.courtCode,
          hideparty: vd.hideparty,
          searchFlag: vd.searchFlag,
          stateCode: vd.stateCode || resolvedState,
          distCode: vd.distCode || resolvedDist,
          complexCode: vd.complexCode || resolvedComplex,
          searchBy: vd.searchBy || "CSpartyName",
        });
        caseDetail = attachOrderPdfProxy(parseCaseDetail(detailHtml), sessionId);

        if (fetchIABusinessFlag && caseDetail.ia_status?.length) {
          for (const ia of caseDetail.ia_status) {
            if (ia.ia_params?.ia_no) {
              try {
                const iaBusinessResponse = await fetchIABusiness(
                  session,
                  ia.ia_params,
                  vd.cino,
                );
                ia.ia_business = iaBusinessResponse.result;
                ia.ia_business_rawHtml = iaBusinessResponse.rawHtml;
              } catch (e) {
                ia.ia_business = { error: e.message };
              }
            }
          }
        }

        if (fetchBusinessFlag && caseDetail.history_of_case_hearing) {
          for (const h of caseDetail.history_of_case_hearing) {
            if (h.business_params?.businessDate) {
              try {
                h.business_detail = await fetchViewBusiness(
                  session,
                  h.business_params,
                  vd.cino,
                );
              } catch (e) {
                h.business_detail = { error: e.message };
              }
            }
          }
        }

        if (fetchPdf) {
          const orderGroups = [caseDetail.interim_orders, caseDetail.final_orders];
          for (const orders of orderGroups) {
            if (!Array.isArray(orders)) continue;
            for (const o of orders) {
              if (o.pdf_params?.normal_v) {
                try {
                  o.pdf = await fetchDisplayPdf(session, o.pdf_params);
                } catch (e) {
                  o.pdf = { error: e.message };
                }
              }
            }
          }
        }
        caseDetail = sanitizeCaseDetailResponse(caseDetail);
      } catch (e) {
        caseDetail = { error: `Failed to fetch details: ${e.message}` };
      }

      enrichedCases.push({ ...c, details: caseDetail });
    }

    const payload = buildPartySearchSuccessResponse({
      normalizedSearch,
      layer1Html,
      responseCaptchaFragment,
      nextCaptcha,
      cases: enrichedCases,
      metadata,
      courtBreakdown,
      resolvedState,
      resolvedDist,
      resolvedComplex,
    });
    payload.result.parsedCases = enrichedCases;
    return sendJsonSuccess(res, payload);
  } catch (err) {
    return res.status(500).json({ success: false, status: 0, error: err.message });
  }
}

async function caseDetail(req, res) {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, error: MESSAGES.MISSING_SESSION_ID });

  try {
    const session = getSession(sessionId);
    const params = {
      caseNo: firstDefined(req.body.caseNo, req.body.case_no),
      cino: req.body.cino || "",
      courtCode: firstDefined(req.body.courtCode, req.body.court_code),
      hideparty: firstDefined(req.body.hideparty, ""),
      searchFlag: firstDefined(req.body.searchFlag, req.body.search_flag, "CScaseNumber"),
      stateCode: firstDefined(req.body.stateCode, req.body.state_code),
      distCode: firstDefined(req.body.distCode, req.body.dist_code),
      complexCode: firstDefined(
        req.body.complexCode,
        req.body.complex_code,
        req.body.court_complex_code,
      ),
      searchBy: firstDefined(req.body.searchBy, req.body.search_by, "CSpartyName"),
    };

    if (!params.caseNo || !params.cino || !params.courtCode) {
      return res.status(400).json({
        success: false,
        error: MESSAGES.MISSING_CASE_DETAIL_FIELDS,
      });
    }

    const html = await fetchViewHistory(session, params);
    const caseDetailResult = sanitizeCaseDetailResponse(
      attachOrderPdfProxy(parseCaseDetail(html), sessionId),
    );
    return sendJsonSuccess(res, {
      message: MESSAGES.CASE_DETAIL_FETCHED,
      result: buildCaseDetailSections(caseDetailResult),
      rawHtml: html,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function iaBusiness(req, res) {
  const { sessionId, ...iaParams } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, error: MESSAGES.MISSING_SESSION_ID });

  try {
    const session = getSession(sessionId);
    const iaResponse = await fetchIABusiness(session, iaParams, iaParams.cinoia);
    return sendJsonSuccess(res, {
      message: MESSAGES.IA_BUSINESS_FETCHED,
      result: iaResponse.result,
      rawHtml: iaResponse.rawHtml,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function businessDetailPost(req, res) {
  const { sessionId, cino, ...bParams } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, error: MESSAGES.MISSING_SESSION_ID });

  try {
    const session = getSession(sessionId);
    const result = await fetchViewBusiness(session, bParams, cino);
    if (!result.data_list && result.status !== 1) {
      return res.status(422).json({
        success: false,
        status: 0,
        error: MESSAGES.EMPTY_VIEW_BUSINESS_RESPONSE,
      });
    }

    return sendJsonSuccess(res, {
      status: result.status,
      message: MESSAGES.BUSINESS_DETAIL_FETCHED,
      result: result.parsed,
      rawHtml: result.rawHtml,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function orderPdfPost(req, res) {
  const { sessionId, ...pdfParams } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, error: MESSAGES.MISSING_SESSION_ID });

  try {
    const session = getSession(sessionId);
    const result = await fetchDisplayPdf(session, pdfParams);
    return sendJsonSuccess(res, {
      message: MESSAGES.ORDER_PDF_METADATA_FETCHED,
      result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function orderPdfGet(req, res) {
  const { sessionId } = req.query;
  if (!sessionId) {
    return res.status(400).json({ success: false, error: MESSAGES.MISSING_SESSION_ID });
  }

  const pdfParams = {
    normal_v: firstDefined(req.query.normal_v, req.query.normalV),
    case_val: firstDefined(req.query.case_val, req.query.caseVal),
    court_code: firstDefined(req.query.court_code, req.query.courtCode),
    filename: req.query.filename || "",
    appFlag: firstDefined(req.query.appFlag, req.query.app_flag, ""),
  };

  if (!pdfParams.normal_v || !pdfParams.case_val || !pdfParams.court_code || !pdfParams.filename) {
    return res.status(400).json({
      success: false,
      error: MESSAGES.MISSING_ORDER_PDF_QUERY,
    });
  }

  try {
    const session = getSession(sessionId);
    const pdfResult = await fetchDisplayPdfBinary(session, pdfParams);
    if (!pdfResult.data || !pdfResult.pdf_url) {
      return res.status(404).json({
        success: false,
        error: MESSAGES.PDF_NOT_AVAILABLE,
      });
    }

    const safeFileName = pdfParams.filename.toString().split("/").pop() || "order.pdf";
    res.setHeader("Content-Type", pdfResult.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeFileName}"`);
    return res.send(Buffer.from(pdfResult.data));
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  caseData,
  caseDetail,
  iaBusiness,
  businessDetailPost,
  orderPdfPost,
  orderPdfGet,
  sanitizeCaseDetailResponse,
  attachOrderPdfProxy,
  buildCaseDetailSections,
};
