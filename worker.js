export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, cors);
    }

    if (!env.GROQ_API_KEY) {
      return json({ error: "GROQ_API_KEY 가 설정되지 않았습니다." }, 500, cors);
    }

    try {
      const body = await request.json();
      const action = body.action;

      if (action === "overview") {
        const overview = await makeOverview(body, env.GROQ_API_KEY);
        return json({ overview }, 200, cors);
      }
      if (action === "detail") {
        const detail = await makeDetail(body, env.GROQ_API_KEY);
        return json({ detail }, 200, cors);
      }
      return json({ error: "Unknown action" }, 400, cors);
    } catch (err) {
      return json({ error: err.message || "Server error" }, 500, cors);
    }
  }
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

async function groqCall(apiKey, prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "당신은 여행 플래너입니다. 사용자가 고른 여행지, 이동 기준, 숙소 우선순위를 반영해 순수 JSON만 반환하세요. 코드블록 금지. 정확하지 않은 승강장 번호나 출구 번호를 단정하지 말고, 일반적으로 빠른 편인 환승 팁 형태로만 안내하세요. 실제 실시간 교통 데이터를 아는 척하지 말고, 일반적인 동선 조언과 후보형 표현을 사용하세요."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(text || "Groq 응답 파싱 실패");
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `Groq 오류 ${res.status}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq 응답이 비어 있습니다.");

  try { return JSON.parse(content); }
  catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Groq JSON 파싱 실패");
  }
}

function commonInfo(body) {
  const styles = (body.styles || []).join(", ") || "관광";
  const movePrefs = (body.movePrefs || []).join(", ") || "최단시간";
  const stayPrefs = (body.stayPrefs || []).join(", ") || "역세권";
  const tripNote = body.tripNote ? `추가 메모: ${body.tripNote}` : "추가 메모: 없음";
  return `여행지: ${body.destination || '도쿄'}
여행 기간: ${body.startDate} ~ ${body.endDate}
인원: 성인 ${body.adults}명, 어린이 ${body.children}명, 유아 ${body.infants}명
스타일: ${styles}
이동 기준: ${movePrefs}
숙소 우선순위: ${stayPrefs}
${tripNote}
어린이 또는 디즈니 스타일이 있으면 디즈니랜드/디즈니씨/마이하마 같은 테마파크 요소를 해당 여행지 맥락에 맞게 반영`;
}

async function makeOverview(body, apiKey) {
  const prompt = `
${commonInfo(body)}

입력된 여행지 여행의 3가지 동선 타입 개요와, 각 동선 타입별 4개 예산 등급 요약을 JSON으로 작성하세요.

동선 타입 key는 반드시 efficient, scenic, full 만 사용.
예산 등급 key는 반드시 budget, value, normal, luxury 만 사용.

JSON 형식:
{
  "routeTypes":[
    {
      "key":"efficient",
      "label":"최단시간 중심",
      "description":"한 줄 설명",
      "grades":{
        "budget":{"summary":"요약","costEstimate":"1인 예상비용"},
        "value":{"summary":"요약","costEstimate":"1인 예상비용"},
        "normal":{"summary":"요약","costEstimate":"1인 예상비용"},
        "luxury":{"summary":"요약","costEstimate":"1인 예상비용"}
      }
    }
  ]
}
`;
  return await groqCall(apiKey, prompt);
}

async function makeDetail(body, apiKey) {
  const allowedSpots = (body.allowedSpots || []).join(", ");
  const routeLabelMap = {
    efficient: "최단시간 중심",
    scenic: "중간 들름 포함",
    full: "많이 담아보기"
  };
  const gradeLabelMap = {
    budget: "최저가",
    value: "가성비",
    normal: "보통",
    luxury: "럭셔리"
  };
  const spotRule = allowedSpots
    ? `반드시 허용된 스폿 이름만 사용하세요:
${allowedSpots}`
    : `스폿 이름은 ${(body.destination || '입력된 여행지')}와 자연스럽게 연결되는 실제 여행지/지역 이름 위주로 작성하세요.`;

  const prompt = `
${commonInfo(body)}
선택된 동선 타입: ${routeLabelMap[body.routeType] || body.routeType}
선택된 예산 등급: ${gradeLabelMap[body.grade] || body.grade}

${spotRule}

요구사항:
- days 배열로 일자별 상세 일정 작성
- 각 stop에는 name, description, tags, transitHint 포함
- transitHint는 "숙소 기준 가까운 역 → 목적지 역 · 노선 후보 / 환승 적은 편 / 도착 후 도보" 같은 일반 환승 팁 형태
- 정확한 승강장 번호나 실시간 시간표를 단정하지 말 것
- flight, hotels, food, activities, transit 외에 optionNotes 배열도 함께 작성
- optionNotes에는 이동 기준과 숙소 우선순위가 어떻게 반영됐는지 짧게 설명
- 같은 장소라도 최단시간형, 중간 들름형, 숙소 중심형 차이가 느껴지게 반영

JSON 형식:
{
  "days":[
    {
      "day":1,
      "title":"일정 제목",
      "dateLabel":"간단 날짜 표기",
      "stops":[
        {
          "name":"장소 이름",
          "description":"설명",
          "tags":["관광"],
          "transitHint":"이동 힌트"
        }
      ]
    }
  ],
  "flight":["문장1","문장2"],
  "hotels":["문장1","문장2"],
  "food":["문장1","문장2"],
  "activities":["문장1","문장2"],
  "transit":["문장1","문장2","문장3"],
  "optionNotes":["문장1","문장2"]
}
`;
  return await groqCall(apiKey, prompt);
}
`;
  return await groqCall(apiKey, prompt);
}
