import React, { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const RECURRING_DATA = [
  { person: 'Cici', tasks: [
    ['Operational Report South', 'daily', 'Daily (Tue–Sat)', 'Check all sections & archive'],
    ['Daily Facility Walkthrough', 'daily', 'Daily (Tue–Sat)', 'Complete the daily facility walkthrough'],
    ['CPR Document', 'weekly', 'Weekly (Wed)', 'Check expiring or missing & text staff to renew'],
    ['Bi-Weekly Count', 'biweekly', 'Bi-weekly (Thu)', 'Count'],
    ['Coach Call Out Sheet', 'biweekly', 'Bi-weekly (Thu)', 'Check court sheets & record any call outs, late arrivals, etc. not yet logged'],
    ['Monthly Count', 'monthly', 'Monthly (Wed)', 'Count'],
  ]},
  { person: 'Davin', tasks: [
    ['Operational Report Pharr', 'daily', 'Daily (Tue–Sat)', 'Check all sections & archive'],
    ['Daily Facility Walkthrough', 'daily', 'Daily (Tue–Sat)', 'Complete the daily facility walkthrough'],
    ['CPR Document', 'weekly', 'Weekly (Wed)', 'Check expiring or missing & text staff to renew'],
    ['Court Sheet Check', 'weekly', 'Weekly (Fri)', 'Go through each clinic of the previous week & verify all shortenings are correct'],
    ['Bi-Weekly Count', 'biweekly', 'Bi-weekly (Thu)', 'Count'],
    ['Coach Call Out Sheet', 'biweekly', 'Bi-weekly (Thu)', 'Check court sheets & record any call outs, late arrivals, etc. not yet logged'],
    ['Monthly Count', 'monthly', 'Monthly (Wed)', 'Count'],
  ]},
  { person: 'Naya', tasks: [
    ['Operational Report WILCO', 'daily', 'Daily (Mon–Thu, Sun)', 'Check all sections & archive'],
    ['Daily Facility Walkthrough', 'daily', 'Daily (Mon–Thu, Sun)', 'Complete the daily facility walkthrough'],
    ['CPR Document', 'weekly', 'Weekly (Wed)', 'Check expiring or missing & text staff to renew'],
    ['Bi-Weekly Count', 'biweekly', 'Bi-weekly (Thu)', 'Count'],
    ['Coach Call Out Sheet', 'biweekly', 'Bi-weekly (Thu)', 'Check court sheets & record any call outs, late arrivals, etc. not yet logged'],
    ['Monthly Count', 'monthly', 'Monthly (Wed)', 'Count'],
  ]},
  { person: 'MOC', tasks: [
    ['Spam Check Report', 'daily', 'Daily (7 days)', 'Check all sections & archive'],
    ['Operational Report South & Pharr', 'daily', 'Daily (Mon, Sun)', 'Check all sections & archive'],
    ['Operational Report WILCO', 'daily', 'Daily (Fri, Sat)', 'Check all sections & archive'],
  ]},
  { person: 'Aldo', tasks: [
    ['Time Off Report', 'saturday', 'Weekly (Sat)', 'Check all time offs & verify no one on time off is scheduled on Connecteam or Club Auto'],
    ['Court Sheet Check', 'weekly', 'Weekly (Fri)', 'Go through each clinic of the previous week & verify all shortenings are correct'],
  ]},
  { person: 'Jacob', tasks: [
    ['Court Sheet Check', 'weekly', 'Weekly (Fri)', 'Go through each clinic of the previous week & verify all shortenings are correct'],
  ]},
];

export default function App() {
  const [boards, setBoards] = useState([]);
  const [boardId, setBoardId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [labels, setLabels] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [userFilter, setUserFilter] = useState("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const calendarRef = useRef(null);
  const pendingScrollRef = useRef(true);
  const nowSec = Math.floor(Date.now() / 1000);

  function isOverdue(t) {
    return t.dueDate && t.dueDate < nowSec && t.status !== "completed" && !t.isArchived;
  }

  function scrollToToday(rootEl) {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    requestAnimationFrame(() => {
      const root = rootEl || document;
      const rows = root.querySelectorAll(".fc-list-day");
      let target = root.querySelector(`.fc-list-day[data-date="${iso}"]`);
      if (!target) {
        for (const row of rows) {
          const d = row.getAttribute("data-date");
          if (d && d >= iso) { target = row; break; }
        }
      }
      if (!target) return;
      const scroller = target.closest(".fc-scroller") || target.closest(".fc-list");
      if (scroller) {
        scroller.scrollTop = target.offsetTop - scroller.offsetTop;
      } else {
        target.scrollIntoView({ block: "start", behavior: "auto" });
      }
    });
  }

  useEffect(() => {
    Promise.all([fetchJson("/api/boards"), fetchJson("/api/users")])
      .then(([bs, us]) => {
        setBoards(bs);
        setUsers(us);
        if (bs.length > 0) setBoardId(bs[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!boardId) return;
    setStatus("loading");
    setTasks([]);
    const controller = new AbortController();
    const params = new URLSearchParams({ stream: "1" });
    if (showCompleted) params.set("includeCompleted", "1");
    const forceRefresh = reloadKey > 0;
    if (forceRefresh) params.set("refresh", "1");

    (async () => {
      try {
        const labelsUrl = `/api/boards/${boardId}/labels${forceRefresh ? "?refresh=1" : ""}`;
        fetchJson(labelsUrl).then(setLabels).catch(() => {});

        const res = await fetch(
          `/api/boards/${boardId}/tasks?${params}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error(`tasks -> ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let gotAny = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            const page = JSON.parse(line);
            setTasks((prev) => prev.concat(page));
            if (!gotAny) { setStatus("ready"); gotAny = true; }
          }
        }
        setStatus("ready");
      } catch (e) {
        if (e.name === "AbortError") return;
        setError(e.message);
        setStatus("error");
      } finally {
        setRefreshing(false);
      }
    })();

    return () => controller.abort();
  }, [boardId, showCompleted, reloadKey]);

  const userMap = useMemo(
    () => Object.fromEntries(users.map((u) => [u.userId, `${u.firstName} ${u.lastName}`])),
    [users]
  );
  const labelMap = useMemo(
    () => Object.fromEntries(labels.map((l) => [l.id, l])),
    [labels]
  );
  const sortedUsers = useMemo(() => {
    const allowed = new Set(
      ["Naya", "Gaby", "Davin", "Cici", "Jacob", "Aldo", "Elizabeth", "Albert"].map((n) =>
        n.toLowerCase()
      )
    );
    return users
      .filter(
        (u) =>
          !u.isArchived &&
          (allowed.has((u.firstName || "").trim().toLowerCase()) ||
            allowed.has((u.lastName || "").trim().toLowerCase()))
      )
      .sort((a, b) => a.firstName.localeCompare(b.firstName));
  }, [users]);

  const userMatches = (t) =>
    userFilter === "all" ? true : (t.userIds || []).includes(Number(userFilter));

  const overdueCount = useMemo(
    () => tasks.filter((t) => isOverdue(t) && userMatches(t)).length,
    [tasks, userFilter, nowSec]
  );

  const events = useMemo(() => {
    const todayStartSec = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const base = tasks.filter((t) => !t.isArchived).filter(userMatches);
    const filtered = overdueOnly
      ? base.filter((t) => isOverdue(t))
      : base
          .filter((t) => t.startTime || isOverdue(t))
          .filter((t) => showCompleted || t.status !== "completed");
    const todayMarker = {
      id: "__today_marker__",
      title: "",
      start: new Date(todayStartSec * 1000),
      allDay: true,
      classNames: ["today-marker"],
    };
    return [todayMarker].concat(filtered.map((t) => {
      const firstLabel = t.labelIds?.[0] ? labelMap[t.labelIds[0]] : null;
      const assignees = (t.userIds || []).map((id) => userMap[id] || `#${id}`);
      const overdue = isOverdue(t);
      let startSec;
      if (overdueOnly) startSec = t.dueDate || t.startTime;
      else if (overdue) startSec = todayStartSec;
      else startSec = t.startTime;
      return {
        id: t.id,
        title: t.title,
        start: new Date(startSec * 1000),
        end: t.dueDate ? new Date(t.dueDate * 1000) : undefined,
        backgroundColor: firstLabel?.color || "#6b7280",
        borderColor: firstLabel?.color || "#6b7280",
        classNames: [
          overdue ? "is-overdue" : "",
          t.status === "completed" ? "is-completed" : "",
        ].filter(Boolean),
        extendedProps: {
          status: t.status,
          overdue,
          assignees,
          labels: (t.labelIds || []).map((id) => labelMap[id]?.name).filter(Boolean),
        },
      };
    }));
  }, [tasks, userMap, labelMap, showCompleted, userFilter, overdueOnly, nowSec]);

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    if (overdueOnly) {
      api.changeView("listYear");
    }
  }, [overdueOnly]);

  useEffect(() => {
    pendingScrollRef.current = true;
  }, [userFilter]);

  useEffect(() => {
    if (status !== "ready") return;
    pendingScrollRef.current = true;
    const api = calendarRef.current?.getApi();
    if (api && api.view.type.startsWith("list")) {
      requestAnimationFrame(() => scrollToToday(api.el));
    }
  }, [status]);

  useEffect(() => {
    if (!recurringOpen) return;
    const onKey = (e) => { if (e.key === "Escape") setRecurringOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [recurringOpen]);

  if (error) return <div className="app"><div className="status">Error: {error}</div></div>;

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Team Tasks Calendar</h1>
        <select
          value={boardId || ""}
          onChange={(e) => setBoardId(Number(e.target.value))}
          disabled={boards.length <= 1}
        >
          {boards.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        {userFilter === "all" && (
          <span className="pick-name-arrow" aria-hidden="true">👉 pick your name!</span>
        )}
        <select
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          className={`user-picker${userFilter === "all" ? " user-picker--pulse" : ""}`}
          aria-label="Filter by user"
        >
          <option value="all">Pick your name ↓</option>
          {sortedUsers.map((u) => (
            <option key={u.userId} value={u.userId}>
              {u.firstName} {u.lastName}
            </option>
          ))}
        </select>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
          />
          Show completed
        </label>
        <button
          type="button"
          className={`refresh-pill${refreshing ? " loading" : ""}`}
          title="Force refresh from Connecteam"
          disabled={refreshing || !boardId}
          onClick={() => {
            if (!boardId) return;
            setRefreshing(true);
            setReloadKey((k) => k + 1);
          }}
        >
          <span className="spin">↻</span> Refresh
        </button>
        <button
          type="button"
          className={`recurring-pill${recurringOpen ? " active" : ""}`}
          title="Recurring tasks by person"
          onClick={() => setRecurringOpen((v) => !v)}
        >
          ↻ Recurring
        </button>
        {overdueCount > 0 && (
          <button
            type="button"
            className={`overdue-pill${overdueOnly ? " active" : ""}`}
            onClick={() => setOverdueOnly((v) => !v)}
            title={overdueOnly ? "Show all" : "Show only overdue"}
          >
            {overdueOnly ? "✕ " : "⚠ "}
            {overdueCount} overdue
          </button>
        )}
        <span className="status">
          {status === "loading" ? "Loading..." : `${events.length} events`}
        </span>
      </div>
      <div className="calendar-wrap">
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView="listMonth"
          headerToolbar={{
            left: "prev,next todayBtn",
            center: "title",
            right: "dayGridMonth,timeGridWeek,timeGridDay,listMonth",
          }}
          customButtons={{
            todayBtn: {
              text: "today",
              click: () => {
                const api = calendarRef.current?.getApi();
                if (!api) return;
                api.today();
                if (api.view.type.startsWith("list")) {
                  scrollToToday(api.el);
                }
              },
            },
          }}
          height="100%"
          events={events}
          dayMaxEvents={3}
          moreLinkClick="popover"
          displayEventEnd={false}
          views={{
            listMonth: { eventOrder: "end,start,title" },
            listWeek: { eventOrder: "end,start,title" },
            listDay: { eventOrder: "end,start,title" },
          }}
          datesSet={(arg) => {
            if (!arg.view.type.startsWith("list")) return;
            scrollToToday(arg.el);
          }}
          eventsSet={() => {
            if (!pendingScrollRef.current) return;
            const api = calendarRef.current?.getApi();
            if (!api) return;
            pendingScrollRef.current = false;
            if (api.view.type.startsWith("list")) {
              scrollToToday(api.el);
            }
          }}
          eventDidMount={(info) => {
            const { assignees, labels, status, overdue } = info.event.extendedProps;
            info.el.title = [
              info.event.title,
              assignees?.length ? `Assignees: ${assignees.join(", ")}` : null,
              labels?.length ? `Labels: ${labels.join(", ")}` : null,
            ].filter(Boolean).join("\n");

            if (info.view.type.startsWith("list")) {
              const titleEl = info.el.querySelector(".fc-list-event-title a, .fc-list-event-title");
              if (titleEl) {
                if (info.event.end) {
                  const due = info.event.end;
                  const sameDay =
                    info.event.start && due.toDateString() === info.event.start.toDateString();
                  const opts = sameDay
                    ? { hour: "numeric", minute: "2-digit" }
                    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
                  const suffix = document.createElement("span");
                  suffix.className = "due-suffix";
                  suffix.textContent = ` (due ${due.toLocaleString(undefined, opts)})`;
                  titleEl.appendChild(suffix);
                }
                if (status === "completed") {
                  const pill = document.createElement("span");
                  pill.className = "pill pill-completed";
                  pill.textContent = "completed";
                  titleEl.appendChild(pill);
                } else if (overdue) {
                  const pill = document.createElement("span");
                  pill.className = "pill pill-overdue";
                  pill.textContent = "overdue";
                  titleEl.appendChild(pill);
                }
              }
            }
          }}
        />
      </div>

      <div
        className={`rec-backdrop${recurringOpen ? " open" : ""}`}
        onClick={() => setRecurringOpen(false)}
      />
      <aside
        className={`rec-drawer${recurringOpen ? " open" : ""}`}
        role="dialog"
        aria-label="Recurring tasks"
        aria-hidden={!recurringOpen}
      >
        <div className="rec-header">
          <h2>Recurring tasks by person</h2>
          <button
            type="button"
            className="rec-close"
            aria-label="Close"
            onClick={() => setRecurringOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="rec-body">
          <table className="rec-table">
            <thead>
              <tr><th>Task</th><th>Frequency</th><th>Action</th></tr>
            </thead>
            <tbody>
              {RECURRING_DATA.map((group) => (
                <React.Fragment key={group.person}>
                  <tr className="rec-person-row">
                    <td colSpan={3}>
                      <span className="rec-person">{group.person}</span>
                    </td>
                  </tr>
                  {group.tasks.map((t, i) => (
                    <tr key={`${group.person}-${i}`}>
                      <td className="rec-task">{t[0]}</td>
                      <td>
                        <span className={`rec-freq rec-freq-${t[1]}`}>{t[2]}</span>
                      </td>
                      <td className="rec-action">{t[3]}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}
