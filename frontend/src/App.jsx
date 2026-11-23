import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Bell, Boxes,
  Building2, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign,
  ClipboardList, CreditCard, Download, Ellipsis, FileBarChart, Filter, LayoutDashboard,
  LogOut, Menu, Minus, Package, Plus, Printer, Search, Settings, ShoppingBag,
  ShoppingCart, SlidersHorizontal, Sparkles, Tag, Trash2, TrendingUp, Truck, UserPlus,
  UserRound, Users, Wallet, X, ClipboardCheck,
} from "lucide-react";
import {
  adjustStock, assignTeamMemberBranch, createBranch, createCustomerOrder, createExpense,
  createProduct, createSale, inviteTeamMember, listCustomerSignupOrganizations,
  loadCustomerPortal, loadWorkspace, removeTeamMember, updateCustomerOrderStatus,
  updateCustomerProfile, updateOrganization, updateTeamMember,
} from "./lib/data";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import { LanguagePicker, useLanguage } from "./lib/i18n";

const navGroups = [
  { label: "OVERVIEW", items: [{ id: "Dashboard", icon: LayoutDashboard }, { id: "Sales", icon: ShoppingCart }, { id: "Products", icon: Package }, { id: "Inventory", icon: Boxes }] },
  { label: "MANAGEMENT", items: [{ id: "Expenses", icon: Wallet }, { id: "Reports", icon: FileBarChart }, { id: "Orders", icon: ClipboardCheck }, { id: "Users", icon: Users }, { id: "Branches", icon: Building2 }] },
  { label: "PREFERENCES", items: [{ id: "Settings", icon: Settings }] },
];

const money = (value, currency = "USD", locale = "en-US") => new Intl.NumberFormat(locale, {
  style: "currency",
  currency: currency || "USD",
}).format(Number(value || 0));

function formatLocalDate(value, locale, includeTime = false) {
  if (!value) return "-";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  const options = includeTime && !dateOnly
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function workspaceLoadErrorMessage(error) {
  const message = error?.message || "";
  if (/Failed to send a request to the Edge Function/i.test(message)) {
    return "Could not reach the team-management Edge Function. Redeploy team-members with gateway JWT verification disabled to allow CORS preflight; the function still validates each session token and admin role.";
  }
  if (error?.code === "PGRST116" || /Cannot coerce the result to a single JSON object/i.test(message)) {
    return "The SMS database is available, but this sign-in is not linked to exactly one workspace profile or organization. Check the signed-in user's profile and organization in Supabase.";
  }
  if (/relation "public\.(organizations|branches|products|inventory|sales|expenses|customer_orders|team_invites)" does not exist|schema cache|Could not find the function|Could not find the table/i.test(message)) {
    return "Supabase sign-in succeeded, but required SMS database objects are missing. Apply the migrations to the same Supabase project configured in .env.local; do not delete existing profiles or users.";
  }
  return message || "Unable to load your workspace.";
}

function Logo({ small = false }) {
  return <div className={`brand-mark${small ? " brand-mark-small" : ""}`} aria-label="Rodas">
    <span className="brand-symbol"><Activity size={20} strokeWidth={2.6} /></span>
    {!small && <span className="brand-name">rodas<span>.</span></span>}
  </div>;
}

function Sidebar({ page, onNavigate, open, onClose, profile, branches, branchId, onBranchChange, lowStockCount, onSignOut, allowedPages }) {
  const { t } = useLanguage();
  const initials = (profile?.full_name || profile?.email || "U").split(/[\s@]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const visibleGroups = navGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowedPages.includes(item.id)),
  })).filter((group) => group.items.length > 0);
  return <>
    {open && <button className="drawer-scrim" aria-label={t("Close navigation")} onClick={onClose} />}
    <aside className={`sidebar${open ? " sidebar-open" : ""}`}>
      <div className="sidebar-brand"><Logo /><button className="icon-button mobile-close" onClick={onClose} aria-label={t("Close menu")}><X size={19} /></button></div>
      <div className="workspace-switch"><span className="workspace-icon"><ShoppingBag size={17} /></span><span className="workspace-copy"><strong>{profile?.organization_name || t("Your workspace")}</strong><select className="branch-select" aria-label={t("Select branch")} value={branchId || ""} onChange={(event) => onBranchChange(event.target.value)} disabled={profile?.role !== "admin"}>{profile?.role === "admin" && <option value="all">{t("All branches")}</option>}{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></span>{profile?.role === "admin" && <ChevronDown size={16} />}</div>
      <nav className="side-nav" aria-label={t("Main navigation")}>
        {visibleGroups.map((group) => <div className="nav-group" key={group.label}>
          <p className="nav-heading">{t(group.label)}</p>
          {group.items.map(({ id, icon: Icon }) => <button key={id} className={`nav-item${page === id ? " active" : ""}`} onClick={() => { onNavigate(id); onClose(); }}>
            <Icon size={18} strokeWidth={1.8} /><span>{t(id)}</span>{id === "Inventory" && lowStockCount > 0 && <span className="nav-count">{lowStockCount}</span>}
          </button>)}
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="help-card"><span className="help-icon"><Sparkles size={16} /></span><strong>{t("Need a hand?")}</strong><p>{t("Visit our help center for tips and guides.")}</p><button>{t("Open help center")} <ChevronRight size={14} /></button></div>
        <div className="profile-row"><span className="avatar">{initials}</span><span className="profile-copy"><strong>{profile?.full_name || profile?.email}</strong><small>{t(({ admin: "Admin", manager: "Branch Manager", cashier: "Staff", inventory_officer: "Inventory Officer" })[profile?.role] || profile?.role)}</small></span></div>
        <button className="sidebar-logout" onClick={onSignOut}><LogOut size={17} />{t("Log out")}</button>
      </div>
    </aside>
  </>;
}

function Topbar({ page, onMenu, query, setQuery, profile, showSearch = true }) {
  const { t } = useLanguage();
  const initials = (profile?.full_name || profile?.email || "U").split(/[\s@]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return <header className="topbar">
    <button className="icon-button menu-button" onClick={onMenu} aria-label={t("Open menu")}><Menu size={21} /></button>
    <div className="breadcrumb"><span>{t("Workspace")}</span><ChevronRight size={14} /><strong>{t(page)}</strong></div>
    {showSearch && <label className="global-search"><Search size={16} /><input placeholder={t("Search anything...")} value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></label>}
    <LanguagePicker className="topbar-language" />
    <div className="topbar-actions"><button className="icon-button notification-button" aria-label={t("Notifications")}><Bell size={19} /><i /></button><span className="topbar-divider" /><div className="topbar-user"><span className="avatar">{initials}</span><span>{profile?.full_name || profile?.email}</span></div></div>
  </header>;
}

function PageHeading({ eyebrow, title, description, actions }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="heading-actions">{actions}</div></div>;
}

function Button({ children, variant = "primary", icon: Icon, onClick, className = "", type = "button", disabled = false }) {
  return <button type={type} className={`button button-${variant} ${className}`} onClick={onClick} disabled={disabled}>{Icon && <Icon size={16} />}{children}</button>;
}

function MetricCard({ title, value, change, icon: Icon, tone, note }) {
  return <article className="metric-card"><div className="metric-top"><span>{title}</span><span className={`metric-icon ${tone}`}><Icon size={18} /></span></div><div className="metric-value">{value}</div><div className="metric-foot"><span className={`metric-change ${change.startsWith("-") ? "negative" : ""}`}>{change.startsWith("-") ? <ArrowDownRight size={14} /> : <ArrowUpRight size={14} />}{change.replace("-", "")}</span><span>{note}</span></div></article>;
}

function SalesChart({ sales, currency }) {
  const { locale, t } = useLanguage();
  const values = Array(12).fill(0);
  const now = Date.now();
  sales.forEach((sale) => {
    const daysAgo = (now - new Date(sale.createdAt || sale.date).getTime()) / 86400000;
    if (daysAgo >= 0 && daysAgo < 30) values[Math.min(11, 11 - Math.floor(daysAgo / 3))] += sale.amount;
  });
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index / 11) * 600},${184 - (value / max) * 155}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L600 200 L0 200 Z`;
  return <div className="chart-area">
    <div className="chart-y-labels"><span>{money(max, currency, locale)}</span><span>{money(max * 0.75, currency, locale)}</span><span>{money(max * 0.5, currency, locale)}</span><span>{money(max * 0.25, currency, locale)}</span><span>{money(0, currency, locale)}</span></div>
    <div className="chart-plot">
      <div className="chart-grid"><i /><i /><i /><i /><i /></div>
      <svg className="line-chart" viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label={t("Sales revenue trend chart")}>
        <defs><linearGradient id="salesFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#5d64e8" stopOpacity=".2" /><stop offset="100%" stopColor="#5d64e8" stopOpacity="0" /></linearGradient></defs>
        <path d={area} fill="url(#salesFill)" />
        <path d={line} fill="none" stroke="#6268e8" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-x-labels"><span>{t("30 days ago")}</span><span>24d</span><span>18d</span><span>12d</span><span>6d</span><span>{t("Today")}</span></div>
    </div>
  </div>;
}

function Dashboard({ products, sales, branches, summary, expenses, profile, onNavigate, currency, branchId }) {
  const { t, locale } = useLanguage();
  const revenue = Number(summary.revenue || 0);
  const grossProfit = Number(summary.gross_profit || 0);
  const expenseTotal = Number(summary.expenses || 0);
  const stockCount = products.reduce((sum, product) => sum + product.stock, 0);
  const lowStock = products.filter((product) => product.isLowStock ?? product.stock <= product.reorderLevel);
  const today = new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  const branchName = branches.find((branch) => branch.id === branchId)?.name;
  const formatMoney = (value) => new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
  return <div className="page-content">
    <PageHeading eyebrow={today.toUpperCase()} title={t("Welcome, {name} 👋", { name: profile.full_name || t("Admin") })} description={branchId === "all" ? t("Here is how your mobile retail business is doing today.") : t("Branch dashboard for {branch}. Inventory, sales, and alerts are limited to this location.", { branch: branchName || t("Assigned branch") })} actions={<Button variant="outline" icon={CalendarDays}>{t("This month")} <ChevronDown size={14} /></Button>} />
    <section className="metrics-grid">
      <MetricCard title={t("Sales this month")} value={Number(summary.sales_count || 0).toLocaleString(locale)} change={t("Live")} note={t("this month")} icon={ShoppingCart} tone="violet" />
      <MetricCard title={t("Revenue")} value={formatMoney(revenue)} change={t("Live")} note={t("this month")} icon={CircleDollarSign} tone="green" />
      <MetricCard title={t("Gross profit")} value={formatMoney(grossProfit)} change={t("Live")} note={t("this month")} icon={TrendingUp} tone="blue" />
      <MetricCard title={t("Net profit")} value={formatMoney(grossProfit - expenseTotal)} change={t("Live")} note={t("after expenses")} icon={Wallet} tone="amber" />
    </section>
    <section className="metrics-grid metrics-grid-secondary">
      <MetricCard title={t("Expenses")} value={formatMoney(expenseTotal)} change={t("Live")} note={t("this month")} icon={CreditCard} tone="rose" />
      <MetricCard title={t("Products")} value={products.length.toLocaleString(locale)} change={t("Live")} note={t("active items")} icon={Package} tone="blue" />
      <MetricCard title={t("Stock units")} value={stockCount.toLocaleString(locale)} change={t("Live")} note={t("selected branch")} icon={Boxes} tone="green" />
      <MetricCard title={t("Branches")} value={branches.length.toLocaleString(locale)} change={t("Live")} note={t("your business")} icon={Building2} tone="violet" />
    </section>
    <div className="dashboard-grid">
      <section className="panel revenue-panel"><div className="panel-heading"><div><h2>{t("Revenue overview")}</h2><p>{t("Daily sales from the last 30 days")}</p></div></div><div className="revenue-summary"><strong>{formatMoney(revenue)}</strong><small>{t("month to date")}</small></div><SalesChart sales={sales} currency={currency} /></section>
      <section className="panel low-stock-panel"><div className="panel-heading"><div><h2>{t("Stock alerts")}</h2><p>{t("Items to replenish at this branch")}</p></div><span className="alert-count">{t("{count} items", { count: lowStock.length })}</span></div>{lowStock.slice(0, 4).map((product) => <div className="stock-alert-row" key={product.id}><span className={`product-thumb ${product.color}`}>{product.image}</span><span className="stock-product"><strong>{product.name}</strong><small>{product.sku}</small></span><span className="stock-level"><strong>{product.stock.toLocaleString(locale)}</strong><small>{t("left")}</small></span></div>)}{lowStock.length === 0 && <p className="empty-note">{t("Everything is stocked up.")}</p>}<button className="text-button stock-link" onClick={() => onNavigate("Inventory")}>{t("Manage inventory")} <ChevronRight size={15} /></button></section>
    </div>
    <div className="dashboard-grid lower-grid">
      <section className="panel table-panel"><div className="panel-heading"><div><h2>{t("Recent sales")}</h2><p>{t("Latest transactions for this branch")}</p></div><button className="text-button" onClick={() => onNavigate("Sales")}>{t("View all")} <ChevronRight size={15} /></button></div><SalesTable rows={sales.slice(0, 5)} currency={currency} /></section>
      <section className="panel low-stock-panel"><div className="panel-heading"><div><h2>{t("Recent expenses")}</h2><p>{t("Latest store costs")}</p></div><span className="alert-count">{t("{count} records", { count: expenses.length })}</span></div>{expenses.slice(0, 4).map((expense) => <div className="stock-alert-row" key={expense.id}><span className="product-thumb blue"><Wallet size={16} /></span><span className="stock-product"><strong>{expense.customer}</strong><small>{formatLocalDate(expense.date, locale)}</small></span><span className="stock-level"><strong>{formatMoney(expense.amount)}</strong></span></div>)}{expenses.length === 0 && <p className="empty-note">{t("No expenses recorded this month.")}</p>}</section>
    </div>
  </div>;
}

function SalesTable({ rows, currency = "USD" }) {
  const { t, locale } = useLanguage();
  return <div className="table-scroll"><table><thead><tr><th>{t("ORDER")}</th><th>{t("CUSTOMER / ITEM")}</th><th>{t("BRANCH")}</th><th>{t("DATE")}</th><th>{t("PAYMENT / CATEGORY")}</th><th>{t("AMOUNT")}</th><th>{t("STATUS")}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="strong-cell">{row.id}</td><td><span className="customer-cell"><span className="customer-avatar">{(row.customer || t("Sale")).split(" ").map((part) => part[0]).join("").slice(0, 2)}</span>{row.customer}</span></td><td>{row.branch || "-"}</td><td>{formatLocalDate(row.date, locale, true)}</td><td>{t(row.method)}</td><td className="strong-cell">{money(row.amount, currency, locale)}</td><td><span className={`status-pill ${(row.status || "Completed").toLowerCase()}`}><i />{t(row.status || "Completed")}</span></td></tr>)}</tbody></table>{rows.length === 0 && <p className="empty-note">{t("No records yet for this branch.")}</p>}</div>;
}

function TeamMembersTable({ members, branches, onAssignBranch, onEdit, disabled }) {
  const { t } = useLanguage();
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  return <div className="table-scroll"><table className="team-table"><thead><tr><th>{t("User")}</th><th>{t("Role")}</th><th>{t("Branch")}</th><th>{t("Status")}</th><th>{t("Actions")}</th></tr></thead><tbody>
    {members.map((member) => {
      const name = member.full_name || member.email;
      const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      const role = t(({ admin: "Admin", manager: "Branch Manager", cashier: "Staff", inventory_officer: "Inventory Officer" })[member.role] || member.role);
      const branchName = member.branch_id ? branchNames.get(member.branch_id) || t("Unassigned") : member.role === "admin" ? t("All Branches") : t("Unassigned");
      const statusKey = member.status === "invited" ? "Invited" : member.status === "active" ? "Active" : "Unavailable";
      const status = t(statusKey);
      const statusClass = statusKey === "Invited" ? "pending" : statusKey === "Active" ? "completed" : "unknown";
      return <tr key={member.id}>
        <td><span className="team-user"><span className="customer-avatar">{initials || "U"}</span><span><strong>{name}</strong><small>{member.email}</small></span></span></td>
        <td><span className={`role-badge role-${member.role}`}>{role}</span></td>
        <td>{branchName === t("Unassigned") ? <span className="branch-unassigned">{branchName}</span> : branchName}</td>
        <td><span className={`status-pill ${statusClass}`}><i />{status}</span></td>
        <td><div className="team-actions"><button type="button" className="team-action-button assign-action" onClick={() => onAssignBranch(member)} disabled={disabled} title={disabled ? t("Deploy the team-management function to enable this action.") : undefined}>{t("Assign Branch")}</button><button type="button" className="team-action-button edit-action" onClick={() => onEdit(member)} disabled={disabled} title={disabled ? t("Deploy the team-management function to enable this action.") : undefined}>{t("Edit / Remove")}</button></div></td>
      </tr>;
    })}
  </tbody></table>{members.length === 0 && <p className="empty-note">{t("No team members match your search.")}</p>}</div>;
}

function ProductTile({ product, addToCart, currency }) {
  const { t, locale } = useLanguage();
  const details = [product.brand, product.model, product.storageGb ? `${product.storageGb} GB` : null, product.deviceColor].filter(Boolean).join(" · ");
  return <button className="pos-product" onClick={() => addToCart(product)}><span className={`pos-product-image ${product.color}`}>{product.image}</span><span className="pos-product-info"><strong>{product.name}</strong><small>{details || t(product.category)} · {t("{count} in stock", { count: product.stock.toLocaleString(locale) })}</small><b>{money(product.price, currency, locale)}</b></span><span className="pos-add"><Plus size={16} /></span></button>;
}

function CustomerPortal({ portal, busy, onSignOut, onRefresh, onPlaceOrder, onSaveProfile }) {
  const { t, locale } = useLanguage();
  const [tab, setTab] = useState("Shop");
  const [branchId, setBranchId] = useState(portal.branches[0]?.id || "");
  const [cart, setCart] = useState([]);
  const [note, setNote] = useState("");
  const [profile, setProfile] = useState({
    name: portal.customer.name || "",
    phone: portal.customer.phone || "",
    address: portal.customer.address || "",
  });
  const moneyText = (value) => money(value, portal.organization.currency, locale);
  const branchName = (id) => portal.branches.find((branch) => branch.id === id)?.name || t("Branch");
  const stockFor = (product) => product.branchStocks.find((branch) => branch.branchId === branchId)?.quantity || 0;
  const updateQuantity = (product, delta) => setCart((items) => {
    const current = items.find((item) => item.id === product.id);
    const nextQuantity = (current?.quantity || 0) + delta;
    if (nextQuantity < 0 || nextQuantity > stockFor(product) || nextQuantity > 99) return items;
    return nextQuantity === 0
      ? items.filter((item) => item.id !== product.id)
      : current
        ? items.map((item) => item.id === product.id ? { ...item, quantity: nextQuantity } : item)
        : [...items, { ...product, quantity: nextQuantity }];
  });
  const placeOrder = async (event) => {
    event.preventDefault();
    const success = await onPlaceOrder({ branchId, items: cart, note });
    if (success) {
      setCart([]);
      setNote("");
      setTab("Orders");
    }
  };
  const saveProfile = async (event) => {
    event.preventDefault();
    await onSaveProfile(profile);
  };
  const tabs = ["Shop", "Orders", "Purchases", "My account"];

  return <div className="customer-portal">
    <header className="customer-portal-header">
      <Logo />
      <div className="customer-portal-store"><strong>{portal.organization.name}</strong><span>{t("Customer account")}</span></div>
      <span className="customer-portal-name">{portal.customer.name}</span>
      <LanguagePicker className="topbar-language" />
      <button className="sidebar-logout" onClick={onSignOut}><LogOut size={17} />{t("Log out")}</button>
    </header>
    <main className="customer-portal-content">
      <PageHeading eyebrow={t("CUSTOMER PORTAL")} title={t("Welcome, {name} 👋", { name: portal.customer.name })} description={t("Browse the store, send a branch order request, and keep track of your account and purchases.")} />
      <nav className="customer-tabs" aria-label={t("Customer account sections")}>
        {tabs.map((item) => <button key={item} type="button" className={tab === item ? "selected" : ""} onClick={() => setTab(item)}>{t(item)}</button>)}
      </nav>

      {tab === "Shop" && <div className="customer-shop-layout">
        <section className="panel customer-catalog">
          <div className="panel-heading"><div><h2>{t("Available products")}</h2><p>{t("Choose the branch where you want to collect your order.")}</p></div><select aria-label={t("Select branch")} value={branchId} onChange={(event) => { setBranchId(event.target.value); setCart([]); }}><option value="" disabled>{t("Select branch")}</option>{portal.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
          <div className="product-grid">
            {portal.products.map((product) => {
              const stock = stockFor(product);
              const item = cart.find((entry) => entry.id === product.id);
              return <article className="product-card" key={product.id}>
                <div className={`product-card-image ${product.color}`}><span>{product.image}</span></div>
                <div className="product-card-body"><span className="product-category">{t(product.category)}</span><h3>{product.name}</h3><small className="product-sku">{product.sku}</small><div className="product-card-footer"><strong>{moneyText(product.price)}</strong><span>{t("{count} in stock", { count: stock.toLocaleString(locale) })}</span></div>
                  <div className="customer-quantity-controls"><button type="button" aria-label={t("Decrease quantity")} onClick={() => updateQuantity(product, -1)} disabled={!item}>−</button><strong>{item?.quantity || 0}</strong><button type="button" aria-label={t("Increase quantity")} onClick={() => updateQuantity(product, 1)} disabled={!branchId || stock < 1 || (item?.quantity || 0) >= stock}>+</button></div>
                </div>
              </article>;
            })}
          </div>
          {!portal.products.length && <p className="empty-note">{t("The store has no active products available right now.")}</p>}
        </section>
        <form className="panel customer-order-cart" onSubmit={placeOrder}>
          <div className="cart-heading"><div><h2>{t("Order request")}</h2><p>{t("{count} items", { count: cart.length })}</p></div><button type="button" className="text-button" onClick={() => setCart([])}>{t("Clear")}</button></div>
          <div className="cart-items">{cart.map((item) => <div className="cart-item" key={item.id}><span className="cart-item-copy"><strong>{item.name}</strong><small>{item.quantity} × {moneyText(item.price)}</small></span><strong>{moneyText(item.quantity * item.price)}</strong></div>)}
            {!cart.length && <p className="empty-note">{t("Add products to start your order request.")}</p>}
          </div>
          <label className="form-field"><span>{t("Note for the branch (optional)")}</span><textarea rows="3" maxLength="500" value={note} onChange={(event) => setNote(event.target.value)} /></label>
          <p className="user-invite-note">{t("This is an order request, not a payment. The branch must confirm availability and payment before it is final. Stock is not reserved until confirmed.")}</p>
          <Button type="submit" disabled={busy || !branchId || !cart.length}>{busy ? t("Sending request...") : t("Send order request")}</Button>
        </form>
      </div>}

      {tab === "Orders" && <section className="customer-order-list">
        {portal.orders.map((order) => <article className="panel customer-order-card" key={order.id}>
          <div className="panel-heading"><div><h2>{t("Order request")} · {order.id.slice(0, 8).toUpperCase()}</h2><p>{branchName(order.branch_id)} · {formatLocalDate(order.created_at, locale, true)}</p></div><span className={`status-pill ${order.status === "completed" ? "completed" : order.status === "cancelled" ? "voided" : "pending"}`}><i />{t(order.status)}</span></div>
          {order.items.map((item, index) => <div className="stock-alert-row" key={`${order.id}-${index}`}><span className="stock-product"><strong>{item.product_name}</strong><small>{item.quantity} × {moneyText(Number(item.unit_price))}</small></span><span className="stock-level"><strong>{moneyText(Number(item.line_total))}</strong></span></div>)}
          <div className="customer-order-total"><span>{t("Estimated total")}</span><strong>{moneyText(order.total)}</strong></div>
          {order.note && <p className="user-invite-note">{t("Your note")}: {order.note}</p>}
          {order.sales_id && <p className="user-invite-note">{t("Completed purchase")}: {order.sales_id.slice(0, 8).toUpperCase()}</p>}
        </article>)}
        {!portal.orders.length && <section className="panel"><p className="empty-note">{t("You have no order requests yet.")}</p></section>}
        <Button variant="outline" onClick={onRefresh}>{t("Refresh orders")}</Button>
      </section>}

      {tab === "Purchases" && <section className="customer-order-list">
        {portal.purchases.map((purchase) => <article className="panel customer-order-card" key={purchase.id}>
          <div className="panel-heading"><div><h2>{t("Receipt")} {purchase.receipt_number}</h2><p>{branchName(purchase.branch_id)} · {formatLocalDate(purchase.created_at, locale, true)}</p></div><strong>{moneyText(purchase.total)}</strong></div>
          {purchase.items.map((item, index) => <div className="stock-alert-row" key={`${purchase.id}-${index}`}><span className="stock-product"><strong>{item.products?.name || t("Product")}</strong><small>{item.quantity} × {moneyText(Number(item.unit_price))}</small></span><span className="stock-level"><strong>{moneyText(Number(item.line_total))}</strong></span></div>)}
        </article>)}
        {!portal.purchases.length && <section className="panel"><p className="empty-note">{t("Your completed purchases will appear here.")}</p></section>}
      </section>}

      {tab === "My account" && <form className="panel customer-account-form" onSubmit={saveProfile}>
        <label className="form-field"><span>{t("Full name")}</span><input required maxLength={160} value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
        <label className="form-field"><span>{t("Email")}</span><input value={portal.customer.email || ""} readOnly /></label>
        <label className="form-field"><span>{t("Phone")}</span><input type="tel" maxLength={40} value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /></label>
        <label className="form-field"><span>{t("Address")}</span><textarea rows="3" maxLength={300} value={profile.address} onChange={(event) => setProfile({ ...profile, address: event.target.value })} /></label>
        <Button type="submit" disabled={busy}>{busy ? t("Saving...") : t("Save account details")}</Button>
      </form>}
    </main>
  </div>;
}

function OrdersPage({ orders, currency, onUpdate, busy }) {
  const { t, locale } = useLanguage();
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const nextStatus = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["ready", "cancelled"],
    ready: ["completed", "cancelled"],
  };
  const label = { confirmed: "Confirm order", ready: "Mark ready", completed: "Complete & record sale", cancelled: "Cancel order" };
  return <div className="page-content">
    <PageHeading eyebrow={t("CUSTOMER SERVICE")} title={t("Customer orders")} description={t("Review customer requests, confirm availability, and record the sale when the order is collected.")} />
    <section className="customer-order-list">
      {orders.map((order) => <article className="panel customer-order-card" key={order.id}>
        <div className="panel-heading"><div><h2>{order.customerName} · {order.id.slice(0, 8).toUpperCase()}</h2><p>{order.branchName} · {formatLocalDate(order.created_at, locale, true)}</p></div><span className={`status-pill ${order.status === "completed" ? "completed" : order.status === "cancelled" ? "voided" : "pending"}`}><i />{t(order.status)}</span></div>
        {order.items.map((item, index) => <div className="stock-alert-row" key={`${order.id}-${index}`}><span className="stock-product"><strong>{item.product_name}</strong><small>{item.quantity} × {money(Number(item.unit_price), currency, locale)}</small></span><span className="stock-level"><strong>{money(Number(item.line_total), currency, locale)}</strong></span></div>)}
        <div className="customer-order-total"><span>{t("Estimated total")}</span><strong>{money(order.total, currency, locale)}</strong></div>
        {order.note && <p className="user-invite-note">{t("Customer note")}: {order.note}</p>}
        {order.status === "ready" && <label className="form-field payment-select"><span>{t("Payment method at collection")}</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="cash">{t("Cash")}</option><option value="card">{t("Card")}</option><option value="mobile">{t("Mobile money")}</option></select></label>}
        {nextStatus[order.status] && <div className="customer-order-actions">{nextStatus[order.status].map((status) => <Button key={status} variant={status === "cancelled" ? "outline" : "primary"} disabled={busy} onClick={() => onUpdate(order.id, status, status === "completed" ? paymentMethod : null)}>{t(label[status])}</Button>)}</div>}
      </article>)}
      {!orders.length && <section className="panel"><p className="empty-note">{t("There are no customer orders for your branches.")}</p></section>}
    </section>
  </div>;
}

function ProductPage({ products, customers, customerId, setCustomerId, branchId, onOpenModal, cart, addToCart, removeFromCart, onCheckout, searchQuery, taxRate, currency, paymentMethod, setPaymentMethod, busy, canSell, canManageProducts }) {
  const { t, locale } = useLanguage();
  const [filter, setFilter] = useState("All products");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("catalog");
  const activeTab = canSell ? tab : "catalog";
  const categories = useMemo(() => [...new Set(products.map((product) => product.category).filter(Boolean))], [products]);
  const shown = useMemo(() => products.filter((p) => (filter === "All products" || (filter === "Low stock" ? p.stock <= p.reorderLevel : p.category === filter)) && `${p.name} ${p.brand || ""} ${p.model || ""} ${p.deviceColor || ""} ${p.storageGb || ""} ${p.sku} ${p.category}`.toLowerCase().includes(`${search} ${searchQuery}`.trim().toLowerCase())), [products, filter, search, searchQuery]);
  const subtotal = cart.reduce((total, item) => total + item.price * item.quantity, 0);
  const tax = subtotal * Number(taxRate || 0);
  const formatMoney = (value) => new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
  const productSubtitle = (product) => [
    product.brand && product.model ? `${product.brand} ${product.model}` : product.brand || product.model,
    product.storageGb ? `${product.storageGb} GB` : null,
    product.deviceColor,
  ].filter(Boolean).join(" · ") || product.category;
  const totalUnits = products.reduce((sum, product) => sum + product.stock, 0);
  return <div className="page-content">
    <PageHeading eyebrow={t("PRODUCT CATALOG")} title={t("Products & POS")} description={t("{products} products · {units} units in stock{branches}.", { products: products.length.toLocaleString(locale), units: totalUnits.toLocaleString(locale), branches: branchId === "all" ? t(" across all branches") : "" })} actions={canManageProducts && <Button className="add-product-button" icon={Plus} onClick={onOpenModal}>{t("Add product")}</Button>} />
    <div className="pos-layout">
      <section className="panel catalog-panel">
        <div className="catalog-toolbar"><div className="tab-switch"><button className={activeTab === "catalog" ? "selected" : ""} onClick={() => setTab("catalog")}><Package size={16} />{t("Catalog")}</button>{canSell && <button className={activeTab === "pos" ? "selected" : ""} onClick={() => branchId !== "all" && setTab("pos")} disabled={branchId === "all"} title={branchId === "all" ? t("Select one branch to make a sale") : undefined}><ShoppingCart size={16} />{t("Point of sale")}</button>}</div><div className="catalog-controls"><label className="field-search"><Search size={16} /><input aria-label={t("Search products...")} placeholder={t("Search products...")} value={search} onChange={(e) => setSearch(e.target.value)} /></label><select aria-label={t("Filter products")} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="All products">{t("All products")}</option><option value="Low stock">{t("Low stock")}</option>{categories.map((category) => <option key={category} value={category}>{t(category)}</option>)}</select></div></div>
        <div className="category-chips">{["All products", "Low stock", ...categories].map((item) => <button className={filter === item ? "chip-active" : ""} key={item} onClick={() => setFilter(item)}>{t(item)}</button>)}</div>
        {activeTab === "catalog" ? <div className="product-grid">{shown.map((product) => <article className="product-card" key={product.id}><div className={`product-card-image ${product.color}`}><span>{product.image}</span><button aria-label={t("Add {name} to cart", { name: product.name })} onClick={() => addToCart(product)} disabled={!canSell || branchId === "all" || product.stock < 1} title={!canSell ? undefined : branchId === "all" ? t("Select one branch to make a sale") : undefined}><Plus size={17} /></button></div><div className="product-card-body"><span className="product-category">{t(productSubtitle(product))}</span><h3>{product.name}</h3><small className="product-sku">{product.sku} · {t(product.category)}</small><div className="product-card-footer"><strong>{formatMoney(product.price)}</strong><span className={product.stock <= product.reorderLevel ? "stock-warning" : ""}>{t("{count} in stock", { count: product.stock.toLocaleString(locale) })}</span></div>{branchId === "all" && product.branchStocks?.length > 0 && <small className="product-branch-stock">{product.branchStocks.filter((branch) => branch.quantity > 0).map((branch) => `${branch.branchName}: ${branch.quantity.toLocaleString(locale)}`).join(" · ") || t("No stock assigned to a branch yet")}</small>}</div></article>)}</div> : <div className="pos-list">{shown.map((product) => <ProductTile key={product.id} product={product} addToCart={addToCart} currency={currency} />)}</div>}
        {shown.length === 0 && <p className="empty-note">{t("No products match your search. Add your first product to get started.")}</p>}
      </section>
      {canSell && <aside className={`panel cart-panel${tab === "pos" ? " cart-panel-focus" : ""}`}><div className="cart-heading"><div><h2>{t("Current order")}</h2><p>{t(cart.length === 1 ? "1 item" : "{count} items", { count: cart.length })}</p></div><button className="icon-button" onClick={() => cart.forEach((item) => removeFromCart(item.id))} aria-label={t("Clear cart")}><Trash2 size={17} /></button></div>
        {branchId === "all" && <p className="branch-required-note">{t("Select a branch from the workspace menu to start a sale.")}</p>}
        <label className="form-field payment-select"><span>{t("Customer")}</span><select value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">{t("Walk-in customer")}</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.email ? ` · ${customer.email}` : ""}</option>)}</select></label>
        <div className="cart-items">{cart.length === 0 ? <div className="empty-cart"><span><ShoppingCart size={23} /></span><strong>{t("Your cart is empty")}</strong><p>{t("Add products to start a sale")}</p></div> : cart.map((item) => <div className="cart-item" key={item.id}><span className={`cart-thumb ${item.color}`}>{item.image}</span><span className="cart-item-copy"><strong>{item.name}</strong><small>{money(item.price, currency, locale)} {t("each")}</small><span className="quantity-controls"><button onClick={() => removeFromCart(item.id)} aria-label={t("Decrease quantity")}><Minus size={13} /></button><b>{item.quantity.toLocaleString(locale)}</b><button onClick={() => addToCart(item)} aria-label={t("Increase quantity")}><Plus size={13} /></button></span></span><strong>{money(item.price * item.quantity, currency, locale)}</strong></div>)}</div>
        <label className="form-field payment-select"><span>{t("Payment method")}</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="cash">{t("Cash")}</option><option value="card">{t("Card")}</option><option value="mobile">{t("Mobile money")}</option></select></label>
        <div className="cart-summary"><div><span>{t("Subtotal")}</span><strong>{formatMoney(subtotal)}</strong></div><div><span>{t("Tax")} ({(Number(taxRate || 0) * 100).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)</span><strong>{formatMoney(tax)}</strong></div><div className="cart-total"><span>{t("Total")}</span><strong>{formatMoney(subtotal + tax)}</strong></div></div>
        <Button className="checkout-button" icon={CreditCard} onClick={onCheckout} disabled={!cart.length || busy}>{busy ? t("Saving sale...") : t("Charge {amount}", { amount: formatMoney(subtotal + tax) })}</Button>
      </aside>}
    </div>
  </div>;
}

function InventoryPage({ products, onRestock, currency, canRestock }) {
  const { t, locale } = useLanguage();
  const [query, setQuery] = useState("");
  const lowStock = products.filter((product) => product.isLowStock ?? product.stock <= product.reorderLevel);
  const formatMoney = (value) => new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
  const stockValue = products.reduce((sum, product) => sum + product.stock * product.cost, 0);
  const filtered = products.filter((product) => `${product.name} ${product.brand || ""} ${product.model || ""} ${product.deviceColor || ""} ${product.storageGb || ""} ${product.sku} ${product.category}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="page-content"><PageHeading eyebrow={t("STOCK CONTROL")} title={t("Inventory")} description={t("Monitor device and accessory stock at the selected branch.")} actions={canRestock && <Button icon={Plus} onClick={() => onRestock(products[0])} disabled={!products.length}>{t("Restock item")}</Button>} />
    <section className="metrics-grid inventory-metrics"><MetricCard title={t("Stock units")} value={products.reduce((sum, product) => sum + product.stock, 0).toLocaleString(locale)} change={t("Live")} note={t("selected branch")} icon={Boxes} tone="blue" /><MetricCard title={t("Low stock items")} value={lowStock.length.toLocaleString(locale)} change={t("Live")} note={t("at reorder level")} icon={AlertTriangle} tone="amber" /><MetricCard title={t("Out of stock")} value={products.filter((product) => product.stock === 0).length.toLocaleString(locale)} change={t("Live")} note={t("needs attention")} icon={Package} tone="rose" /><MetricCard title={t("Stock value")} value={formatMoney(stockValue)} change={t("Live")} note={t("cost value")} icon={CircleDollarSign} tone="green" /></section>
    <section className="panel table-panel inventory-table"><div className="panel-heading"><div><h2>{t("Stock overview")}</h2><p>{t("Inventory at the selected branch")}</p></div><div className="table-tools"><label className="field-search"><Search size={15} /><input aria-label={t("Search products")} placeholder={t("Search products")} value={query} onChange={(event) => setQuery(event.target.value)} /></label></div></div><div className="table-scroll"><table><thead><tr><th>{t("PRODUCT")}</th><th>{t("SKU")}</th><th>{t("CATEGORY")}</th><th>{t("IN STOCK")}</th><th>{t("REORDER LEVEL")}</th><th>{t("STATUS")}</th>{canRestock && <th>{t("ACTION")}</th>}</tr></thead><tbody>{filtered.map((product) => <tr key={product.id}><td><span className="customer-cell"><span className={`table-product-thumb ${product.color}`}>{product.image}</span><span className="inventory-product-copy"><strong>{product.name}</strong><small>{[product.brand, product.model, product.storageGb ? `${product.storageGb} GB` : null, product.deviceColor].filter(Boolean).join(" · ") || t("No model details")}</small></span></span></td><td>{product.sku}</td><td>{t(product.category)}</td><td className="strong-cell">{product.stock.toLocaleString(locale)}</td><td>{product.reorderLevel.toLocaleString(locale)}</td><td><span className={`status-pill ${product.stock <= product.reorderLevel ? "pending" : "completed"}`}><i />{t(product.stock <= product.reorderLevel ? "Low stock" : "In stock")}</span></td>{canRestock && <td><button className="text-button" onClick={() => onRestock(product)}>{t("Restock")} <ChevronRight size={14} /></button></td>}</tr>)}</tbody></table>{filtered.length === 0 && <p className="empty-note">{t("No products match your search.")}</p>}</div></section>
  </div>;
}

function GenericPage({ page, workspace, onOpenModal, onNavigate, onSaveSettings, onAssignBranch, onEditMember, busy }) {
  const { t, locale } = useLanguage();
  const [filter, setFilter] = useState("");
  const [name, setName] = useState(workspace.organization.name);
  const [taxRate, setTaxRate] = useState((Number(workspace.organization.tax_rate) * 100).toString());
  const [currency, setCurrency] = useState(workspace.organization.currency);
  const config = {
    Sales: ["SALES & CHECKOUT", "Sales", "Completed transactions for the selected branch.", "Open point of sale"],
    Expenses: ["FINANCIALS", "Expenses", "Track operating costs for this branch.", "Add expense"],
    Reports: ["INSIGHTS", "Reports", "Sales and profit summaries for this branch.", "Print report"],
    Users: ["TEAM ACCESS", "Users", "People who can access your organization.", ""],
    Branches: ["LOCATIONS", "Branches", "Switch between branch stock and sales.", "Add branch"],
    Settings: ["PREFERENCES", "Settings", "Manage your organization-wide settings.", "Save settings"],
  };
  const [eyebrowKey, titleKey, descriptionKey, buttonLabelKey] = config[page];
  const rows = page === "Sales" ? workspace.sales
    : page === "Expenses" ? workspace.expenses
      : page === "Branches" ? workspace.branches.map((branch) => ({
        id: branch.id.slice(0, 8).toUpperCase(),
        customer: branch.name,
        date: branch.address || t("No address"),
        method: "Branch",
        amount: 0,
        status: branch.active ? "Active" : "Inactive",
      }))
        : workspace.team.map((member) => ({
          id: member.id.slice(0, 8).toUpperCase(),
          customer: member.full_name || member.email,
          date: member.email,
          method: member.branch_id === workspace.branchId ? "Selected branch" : "Team",
          amount: 0,
          status: member.role,
        }));
  const filtered = rows.filter((row) => `${row.id} ${row.customer} ${row.method}`.toLowerCase().includes(filter.toLowerCase()));
  const filteredTeam = workspace.team.filter((member) =>
    `${member.full_name} ${member.email} ${member.role} ${member.status} ${workspace.branches.find((branch) => branch.id === member.branch_id)?.name || ""}`
      .toLowerCase().includes(filter.toLowerCase()));
  const visibleCount = page === "Users" ? filteredTeam.length : filtered.length;
  const teamManagementAvailable = !workspace.teamManagementError;
  const formatMoney = (value) => new Intl.NumberFormat(locale, { style: "currency", currency: workspace.organization.currency }).format(value);
  const eyebrow = t(eyebrowKey);
  const title = t(titleKey);
  const description = t(descriptionKey);
  if (page === "Settings") return <div className="page-content">
    <PageHeading eyebrow={eyebrow} title={title} description={description} />
    <form className="panel settings-form" onSubmit={(event) => { event.preventDefault(); onSaveSettings({ name, taxRate: Number(taxRate) / 100, currency }); }}>
      <label className="form-field"><span>{t("Business name")}</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
      <div className="form-row"><label className="form-field"><span>{t("Sales tax (%)")}</span><input type="number" min="0" max="100" step="0.01" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} required /></label><label className="form-field"><span>{t("Currency")}</span><select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="USD">{t("USD — US Dollar")}</option><option value="ETB">{t("ETB — Ethiopian Birr")}</option><option value="KES">{t("KES — Kenyan Shilling")}</option><option value="UGX">{t("UGX — Ugandan Shilling")}</option><option value="TZS">{t("TZS — Tanzanian Shilling")}</option></select></label></div>
      <Button type="submit" disabled={busy}>{busy ? t("Saving...") : t("Save settings")}</Button>
    </form>
  </div>;
  const summary = workspace.summary;
  const rowsCount = page === "Sales" ? Number(summary.sales_count || 0) : page === "Expenses" ? workspace.expenses.length : page === "Branches" ? workspace.branches.length : workspace.team.length;
  return <div className="page-content">
    <PageHeading eyebrow={eyebrow} title={title} description={description} actions={page === "Users"
      ? <Button className="add-user-button" icon={UserPlus} onClick={() => onOpenModal("user")} disabled={!teamManagementAvailable} title={!teamManagementAvailable ? t("Deploy the team-management function to enable this action.") : undefined}>{t("Add User")}</Button>
      : buttonLabelKey && <Button icon={page === "Sales" ? ShoppingCart : page === "Reports" ? Printer : Plus} onClick={() => page === "Sales" ? onNavigate("Products") : page === "Reports" ? window.print() : onOpenModal(page === "Branches" ? "branch" : "expense")}>{t(buttonLabelKey)}</Button>} />
    {page === "Reports" && <section className="metrics-grid report-metrics">
      <MetricCard title={t("Revenue this month")} value={formatMoney(Number(summary.revenue || 0))} change={t("Live")} note={t("selected branch")} icon={CircleDollarSign} tone="green" />
      <MetricCard title={t("Expenses this month")} value={formatMoney(Number(summary.expenses || 0))} change={t("Live")} note={t("selected branch")} icon={Wallet} tone="rose" />
      <MetricCard title={t("Gross profit")} value={formatMoney(Number(summary.gross_profit || 0))} change={t("Live")} note={t("before expenses")} icon={TrendingUp} tone="blue" />
      <MetricCard title={t("Net profit")} value={formatMoney(Number(summary.gross_profit || 0) - Number(summary.expenses || 0))} change={t("Live")} note={t("after expenses")} icon={Activity} tone="violet" />
    </section>}
    {page === "Reports" &&     <section className="panel revenue-panel"><div className="panel-heading"><div><h2>{t("Revenue trends")}</h2><p>{t("Recent transaction totals")}</p></div></div><SalesChart sales={workspace.sales} currency={workspace.organization.currency} /></section>}
    {page === "Users" && workspace.teamManagementError && <div className="team-management-notice" role="status"><AlertTriangle size={18} /><div><strong>{t("Team management is temporarily unavailable.")}</strong><p>{t("The member list is read-only until the team-members Edge Function is redeployed with gateway JWT verification disabled. The function still validates each session and administrator role.")}</p></div></div>}
    <section className="panel table-panel data-table-panel">
      <div className="panel-heading"><div><h2>{t(page === "Sales" ? "Recent transactions" : page === "Expenses" ? "Recent expenses" : page === "Branches" ? "Branches" : page === "Users" ? "Team members" : "Records")}</h2><p>{t("{count} records in this view", { count: rowsCount.toLocaleString(locale) })}</p></div><label className="field-search"><Search size={15} /><input aria-label={t("Search...")} placeholder={t("Search...")} value={filter} onChange={(event) => setFilter(event.target.value)} /></label></div>
      {page === "Users"
        ? <TeamMembersTable members={filteredTeam} branches={workspace.branches} onAssignBranch={onAssignBranch} onEdit={onEditMember} disabled={!teamManagementAvailable} />
        : <SalesTable rows={filtered} currency={workspace.organization.currency} />}
      <div className="pagination"><span>{t("Showing")} <strong>{visibleCount ? `1–${visibleCount.toLocaleString(locale)}` : "0"}</strong> {t("of")} <strong>{rowsCount.toLocaleString(locale)}</strong> {t("records")}</span></div>
    </section>
  </div>;
}

function Modal({ type, record, branches = [], branchId, onClose, onSave, busy }) {
  const { t } = useLanguage();
  const [values, setValues] = useState({
    name: record?.name || "",
    sku: "",
    category: type === "expense" ? "Rent" : "Phones",
    brand: "",
    model: "",
    color: "",
    storageGb: "",
    branchId: branchId && branchId !== "all" ? branchId : branches[0]?.id || "",
    price: "",
    cost: "",
    quantity: "",
    reorderLevel: String(record?.reorderLevel ?? 3),
    address: "",
    amount: "",
  });
  const set = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }));
  const headings = { product: "Add product", expense: "Record expense", branch: "Add branch", restock: "Restock inventory" };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><form className={`modal${type === "product" ? " product-modal" : ""}`} onSubmit={(event) => { event.preventDefault(); onSave(values); }}>
    <div className="modal-header"><div><span className="eyebrow">{t(type === "product" ? "PRODUCT CATALOG" : "MOBILE RETAIL")}</span><h2>{t(headings[type])}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")} disabled={busy}><X size={19} /></button></div>
    {type === "product" && <>
      <label className="form-field"><span>{t("Product name")}</span><input autoFocus required maxLength={160} value={values.name} onChange={set("name")} placeholder={t("e.g. Samsung Galaxy S24")} /></label>
      <div className="form-row"><label className="form-field"><span>{t("Brand")}</span><input maxLength={120} value={values.brand} onChange={set("brand")} placeholder={t("e.g. Samsung")} /></label><label className="form-field"><span>{t("Model")}</span><input maxLength={120} value={values.model} onChange={set("model")} placeholder={t("e.g. Galaxy S24")} /></label></div>
      <div className="form-row"><label className="form-field"><span>{t("Category")}</span><select value={values.category} onChange={set("category")}><option value="Phones">{t("Phones")}</option><option value="Accessories">{t("Accessories")}</option><option value="Repairs">{t("Repairs")}</option><option value="General">{t("General")}</option></select></label><label className="form-field"><span>{t("Storage (GB)")}</span><input type="number" min="1" step="1" value={values.storageGb} onChange={set("storageGb")} placeholder="e.g. 256" /></label></div>
      <div className="form-row"><label className="form-field"><span>{t("Color")}</span><input maxLength={60} value={values.color} onChange={set("color")} placeholder={t("e.g. Black")} /></label><label className="form-field"><span>{t("SKU / barcode")} <small>({t("optional")})</small></span><input maxLength={80} value={values.sku} onChange={set("sku")} placeholder={t("Generated if left blank")} /></label></div>
      <label className="form-field"><span>{t("Assign to branch")}</span><select required value={values.branchId} onChange={set("branchId")}><option value="" disabled>{t("Select branch")}</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><small className="field-hint">{t("The product is available in every branch; opening stock is assigned only to this branch.")}</small></label>
      <div className="form-row"><label className="form-field"><span>{t("Selling price")}</span><input type="number" min="0.01" step="0.01" required value={values.price} onChange={set("price")} /></label><label className="form-field"><span>{t("Cost price")}</span><input type="number" min="0" step="0.01" required value={values.cost} onChange={set("cost")} /></label></div>
      <div className="form-row"><label className="form-field"><span>{t("Opening stock")}</span><input type="number" min="0" step="1" required value={values.quantity} onChange={set("quantity")} /></label><label className="form-field"><span>{t("Low-stock alert at")}</span><input type="number" min="0" step="1" required value={values.reorderLevel} onChange={set("reorderLevel")} /></label></div>
    </>}
    {type === "expense" && <><label className="form-field"><span>{t("Expense description")}</span><input autoFocus required value={values.name} onChange={set("name")} placeholder={t("e.g. Store rent")} /></label><div className="form-row"><label className="form-field"><span>{t("Amount")}</span><input type="number" min="0.01" step="0.01" required value={values.amount} onChange={set("amount")} /></label><label className="form-field"><span>{t("Category")}</span><select value={values.category} onChange={set("category")}><option value="Rent">{t("Rent")}</option><option value="Utilities">{t("Utilities")}</option><option value="Transport">{t("Transport")}</option><option value="Supplies">{t("Supplies")}</option><option value="Payroll">{t("Payroll")}</option><option value="Other">{t("Other")}</option></select></label></div></>}
    {type === "branch" && <><label className="form-field"><span>{t("Branch name")}</span><input autoFocus required maxLength={120} value={values.name} onChange={set("name")} placeholder={t("e.g. City Center")} /></label><label className="form-field"><span>{t("Address (optional)")}</span><input value={values.address} onChange={set("address")} placeholder={t("Street, city")} /></label><p className="empty-note">{t("A stock record will be created for each active product at this branch.")}</p></>}
    {type === "restock" && <><p className="restock-product">{record?.name} · {t("Current stock")}: {record?.stock}</p><div className="form-row"><label className="form-field"><span>{t("Units received")}</span><input autoFocus type="number" min="1" step="1" required value={values.quantity} onChange={set("quantity")} /></label><label className="form-field"><span>{t("New low-stock alert")}</span><input type="number" min="0" step="1" required value={values.reorderLevel} onChange={set("reorderLevel")} /></label></div></>}
    <div className="modal-actions"><Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t("Cancel")}</Button><Button type="submit" disabled={busy}>{busy ? t("Saving...") : t(type === "product" ? "Add product" : "Save")}</Button></div>
  </form></div>;
}

function TeamMemberModal({ type, record, branches, onClose, onSave, onRemove, error, busy }) {
  const { t } = useLanguage();
  const isInvite = type === "user";
  const isBranchOnly = type === "assignBranch";
  const [values, setValues] = useState({
    fullName: record?.full_name || "",
    email: record?.email || "",
    password: "",
    confirmPassword: "",
    role: record?.role || "cashier",
    branchId: record?.branch_id || (record?.role === "admin" ? "all" : isInvite ? branches[0]?.id || "" : ""),
  });
  const allBranchesAllowed = (isBranchOnly ? record?.role : values.role) === "admin";
  const set = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }));
  const setRole = (event) => setValues((current) => ({
    ...current,
    role: event.target.value,
    branchId: event.target.value === "admin"
      ? "all"
      : current.branchId === "all" || !current.branchId ? branches[0]?.id || "" : current.branchId,
  }));
  const submit = (event) => {
    event.preventDefault();
    if (isInvite && values.password.length < 8) {
      alert(t("Use at least 8 characters for the staff password."));
      return;
    }
    if (isInvite && values.password !== values.confirmPassword) {
      alert(t("The passwords do not match."));
      return;
    }
    const branchId = values.branchId === "all" ? null : values.branchId || null;
    onSave(isBranchOnly
      ? { branchId }
      : { fullName: values.fullName.trim(), email: values.email.trim(), password: values.password, role: values.role, branchId });
  };
  const heading = isInvite ? t("Add user") : isBranchOnly ? `${t("Assign branch")} · ${record?.full_name || record?.email}` : t("Edit team member");

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="modal user-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="team-modal-title">
      <div className="modal-header"><div><span className="eyebrow">{t("TEAM ACCESS")}</span><h2 id="team-modal-title">{heading}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label={t("Close dialog")} disabled={busy}><X size={19} /></button></div>
      {!isBranchOnly && <>
        <label className="form-field"><span>{t("Full Name")}</span><input autoFocus required maxLength={120} value={values.fullName} onChange={set("fullName")} placeholder={t("e.g. Alex Morgan")} /></label>
        <label className="form-field"><span>{t("Email Address")}</span><input type="email" autoComplete="email" required maxLength={254} value={values.email} onChange={set("email")} placeholder="name@example.com" disabled={!isInvite} /></label>
        {isInvite && <>
          <div className="form-row">
            <label className="form-field"><span>{t("Password")}</span><input type="password" autoComplete="new-password" required minLength={8} value={values.password} onChange={set("password")} /></label>
            <label className="form-field"><span>{t("Confirm password")}</span><input type="password" autoComplete="new-password" required minLength={8} value={values.confirmPassword} onChange={set("confirmPassword")} /></label>
          </div>
        </>}
        <label className="form-field"><span>{t("Role")}</span><select value={values.role} onChange={setRole}><option value="admin">{t("Admin")}</option><option value="manager">{t("Branch Manager")}</option><option value="cashier">{t("Staff")}</option><option value="inventory_officer">{t("Inventory Officer")}</option></select></label>
      </>}
      <label className="form-field"><span>{t("Assign Branch")}</span><select autoFocus={isBranchOnly} required={!allBranchesAllowed} value={values.branchId} onChange={set("branchId")}><option value="" disabled={!allBranchesAllowed}>{t(allBranchesAllowed ? "Unassigned" : "Select branch")}</option>{allBranchesAllowed && <option value="all">{t("All Branches")}</option>}{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
      {isInvite && <p className="user-invite-note">{t("Create a password for this staff member. Give the email and password to the staff member so they can sign in immediately.")}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className={`modal-actions user-modal-actions${type === "editUser" ? " has-remove" : ""}`}>
        {type === "editUser" && <button type="button" className="modal-danger-button" onClick={onRemove} disabled={busy}><Trash2 size={15} />{t("Remove user")}</button>}
        <Button type="button" variant="outline" className="user-cancel-button" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
        <Button type="submit" className="user-submit-button" disabled={busy}>{busy ? t("Saving...") : t(isInvite ? "Create & Assign User" : isBranchOnly ? "Save Branch" : "Save Changes")}</Button>
      </div>
    </form>
  </div>;
}

function AuthPage() {
  const { t } = useLanguage();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [organizations, setOrganizations] = useState([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (mode !== "register") return undefined;
    let active = true;
    setOrganizationsLoading(true);
    listCustomerSignupOrganizations().then((items) => {
      if (!active) return;
      setOrganizations(items);
      if (items.length === 1) setOrganizationId(items[0].id);
      if (!items.length) setError(t("Customer registration is not available yet."));
    }).catch((requestError) => {
      if (active) setError(requestError.message || t("Unable to load available stores."));
    }).finally(() => {
      if (active) setOrganizationsLoading(false);
    });
    return () => { active = false; };
  }, [mode, t]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "register") {
        if (password.length < 8) throw new Error(t("Use at least 8 characters for your password."));
        if (password !== confirmPassword) throw new Error(t("The passwords do not match."));
        if (!organizations.some((organization) => organization.id === organizationId)) {
          throw new Error(t("Choose a store before creating your account."));
        }
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              account_type: "customer",
              organization_id: organizationId,
              full_name: fullName.trim(),
              phone: phone.trim(),
            },
          },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setNotice(t("Account request submitted. Check your email to confirm the account, then sign in."));
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
      }
    } catch (requestError) {
      setError(requestError.message || "Authentication failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return   <main className="auth-shell"><div className="auth-card">
  <div className="auth-card-top"><Logo /><LanguagePicker className="auth-language" /></div>
  <span className="eyebrow">{t(mode === "register" ? "CUSTOMER ACCOUNT" : "RODAS WORKSPACE")}</span>
  <h1>{t(mode === "register" ? "Create your customer account" : "Welcome back")}</h1>
  <p>{t(mode === "register" ? "Register to browse products, send order requests to a branch, and track your purchases." : "Sign in to your assigned Rodas workspace to access your branch's inventory and sales.")}</p>
    <form onSubmit={submit}>
    {mode === "register" && <>
      <label className="form-field"><span>{t("Full name")}</span><input autoComplete="name" required maxLength={160} value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
      <label className="form-field"><span>{t("Store")}</span><select required value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} disabled={organizationsLoading || !organizations.length}><option value="">{t(organizationsLoading ? "Loading stores..." : "Select a store")}</option>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
      <label className="form-field"><span>{t("Phone (optional)")}</span><input type="tel" autoComplete="tel" maxLength={40} value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
    </>}
    <label className="form-field"><span>{t("Email")}</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
    <label className="form-field"><span>{t(mode === "register" ? "Password (at least 8 characters)" : "Password")}</span><input type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 8 : undefined} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    {mode === "register" && <label className="form-field"><span>{t("Confirm password")}</span><input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="user-invite-note" role="status">{notice}</p>}
    <Button type="submit" disabled={busy || organizationsLoading || (mode === "register" && !organizations.length)}>{busy ? t(mode === "register" ? "Creating account..." : "Signing in...") : t(mode === "register" ? "Create customer account" : "Sign in securely")}</Button>
    </form>
  <p className="auth-footnote">{t(mode === "register" ? "Already have an account?" : "New customer?")}{` `}<button type="button" className="text-button" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); setNotice(""); }}>{t(mode === "register" ? "Sign in" : "Create account")}</button></p>
  {mode === "login" && <p className="auth-footnote">{t("Staff accounts are created by an administrator. Staff members sign in with their assigned email and password.")}</p>}
  </div></main>;
}

function PasswordSetupPage() {
  const { t } = useLanguage();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (password.length < 8) {
      setError(t("Use at least 8 characters for your password."));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("The passwords do not match."));
      return;
    }
    setBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
        data: { team_invite_token: null },
      });
      if (updateError) throw updateError;
      setSaved(true);
    } catch (requestError) {
      setError(requestError.message || t("Unable to set your password. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return <main className="auth-shell"><div className="auth-card">
    <div className="auth-card-top"><Logo /><LanguagePicker className="auth-language" /></div>
    <span className="eyebrow">{t("SECURE ACCOUNT SETUP")}</span>
    <h1>{t(saved ? "Your account is ready" : "Choose your password")}</h1>
    <p>{t(saved ? "Your password is saved. Your assigned branch workspace is ready." : "Create a private password for your account. Your administrator will never see it.")}</p>
    {!saved ? <form onSubmit={submit}>
      <label className="form-field"><span>{t("New password")}</span><input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="form-field"><span>{t("Confirm password")}</span><input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? t("Saving...") : t("Save password and continue")}</Button>
    </form> : <p className="user-invite-note">{t("You are signing in to the branch assigned by your administrator.")}</p>}
  </div></main>;
}

function App() {
  const { t } = useLanguage();
  const [page, setPage] = useState("Dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [cart, setCart] = useState([]);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState("");
  const [session, setSession] = useState(null);
  const sessionUserId = useRef(null);
  const [workspace, setWorkspace] = useState(null);
  const [customerPortal, setCustomerPortal] = useState(null);
  const [branchId, setBranchId] = useState(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");

  const notify = (message) => {
    setToast(t(message));
    window.setTimeout(() => setToast(""), 3000);
  };

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) {
        const nextUserId = nextSession?.user?.id || null;
        if (sessionUserId.current !== nextUserId) {
          sessionUserId.current = nextUserId;
          setWorkspace(null);
          setCustomerPortal(null);
          setBranchId(null);
          setSelectedCustomerId("");
        }
        setSession(nextSession);
      }
    });
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) setError(sessionError.message);
      sessionUserId.current = data.session?.user?.id || null;
      setSession(data.session);
      setWorkspace(null);
      setCustomerPortal(null);
      setLoading(false);
    }).catch((sessionError) => {
      if (active) setError(sessionError.message || "Unable to check your sign-in status.");
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) {
      setWorkspace(null);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const nextWorkspace = await loadWorkspace(userId, branchId);
        if (!active) return;
        nextWorkspace.profile.organization_name = nextWorkspace.organization.name;
        setWorkspace(nextWorkspace);
        setCustomerPortal(null);
        setBranchId(nextWorkspace.branchId);
        setError("");
      } catch (loadError) {
        try {
          const nextCustomerPortal = await loadCustomerPortal(userId);
          if (!active) return;
          setCustomerPortal(nextCustomerPortal);
          setWorkspace(null);
          setError("");
        } catch {
          if (!active) return;
          setError(workspaceLoadErrorMessage(loadError));
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [session?.user?.id, branchId]);

  const runOperation = async (operation, successMessage, refreshBranchId = branchId) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      const nextWorkspace = await loadWorkspace(session.user.id, refreshBranchId);
      nextWorkspace.profile.organization_name = nextWorkspace.organization.name;
      setWorkspace(nextWorkspace);
      setBranchId(nextWorkspace.branchId);
      setError("");
      setModal(null);
      if (successMessage) notify(successMessage);
      return true;
    } catch (operationError) {
      setError(operationError.message || "The operation failed. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addToCart = (product) => {
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      if ((existing?.quantity || 0) >= product.stock) {
        notify("There is not enough stock for this item.");
        return current;
      }
      if (existing) return current.map((item) => item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      return [...current, { ...product, quantity: 1 }];
    });
  };
  const removeFromCart = (id) => setCart((current) => current.map((item) => item.id === id ? { ...item, quantity: item.quantity - 1 } : item).filter((item) => item.quantity > 0));
  const checkout = () => {
    if (!cart.length) return;
    const customer = workspace.customers.find((item) => item.id === selectedCustomerId);
    runOperation(() => createSale({
      branchId,
      items: cart,
      paymentMethod,
      customerId: selectedCustomerId,
      customerName: customer?.name,
    }), "Sale completed successfully.")
      .then((succeeded) => {
        if (succeeded) {
          setCart([]);
          setSelectedCustomerId("");
        }
      });
  };

  const runCustomerOperation = async (operation, successMessage) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      const nextPortal = await loadCustomerPortal(session.user.id);
      setCustomerPortal(nextPortal);
      if (successMessage) notify(successMessage);
      return true;
    } catch (operationError) {
      setError(operationError.message || t("The operation failed. Please try again."));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveModal = (values) => {
    if (modal?.type === "user") {
      return runOperation(() => inviteTeamMember(values), `Staff account created. Email: ${values.email.trim()}. The administrator assigned the password entered in the form.`);
    }
    if (modal?.type === "assignBranch") {
      return runOperation(() => assignTeamMemberBranch({ userId: modal.record.id, branchId: values.branchId }), "Branch assignment updated successfully.");
    }
    if (modal?.type === "editUser") {
      return runOperation(() => updateTeamMember({ userId: modal.record.id, ...values }), "Team member updated successfully.");
    }
    if (modal?.type === "product") {
      return runOperation(() => createProduct({
        branchId: values.branchId,
        sku: values.sku,
        name: values.name,
        category: values.category,
        brand: values.brand,
        model: values.model,
        color: values.color,
        storageGb: values.storageGb,
        price: Number(values.price),
        cost: Number(values.cost),
        quantity: Number(values.quantity),
        reorderLevel: Number(values.reorderLevel),
      }), "Product added successfully and assigned to the selected branch.", branchId === "all" ? "all" : values.branchId);
    }
    if (modal?.type === "restock") {
      return runOperation(() => adjustStock({
        branchId,
        productId: modal.record.id,
        quantityDelta: Number(values.quantity),
        reorderLevel: Number(values.reorderLevel),
      }), "Inventory updated successfully.");
    }
    if (modal?.type === "expense") {
      return runOperation(() => createExpense({
        organizationId: workspace.profile.organization_id,
        branchId,
        userId: session.user.id,
        title: values.name,
        category: values.category,
        amount: Number(values.amount),
      }), "Expense recorded successfully.");
    }
    if (modal?.type === "branch") {
      return runOperation(() => createBranch({
        organizationId: workspace.profile.organization_id,
        name: values.name,
        address: values.address,
      }), "Branch added successfully.");
    }
  };
  const removeMember = () => {
    if (!modal?.record || !window.confirm(t("Remove {name} from this workspace?", { name: modal.record.full_name || modal.record.email }))) return;
    return runOperation(() => removeTeamMember({ userId: modal.record.id }), "Team member removed successfully.");
  };
  const saveSettings = ({ name, taxRate, currency }) => runOperation(() => updateOrganization({
    organizationId: workspace.profile.organization_id,
    name,
    taxRate,
    currency,
  }), "Settings saved successfully.");
  const updateOrder = (orderId, status, orderPaymentMethod) => runOperation(
    () => updateCustomerOrderStatus({ orderId, status, paymentMethod: orderPaymentMethod }),
    status === "completed" ? "Order completed and sale recorded." : `Order ${status}.`,
  );
  const openModal = (type) => {
    if (type === "expense" && branchId === "all") {
      notify(t("Select a branch to record an expense."));
      return;
    }
    setError("");
    setModal({ type });
  };

  if (!isSupabaseConfigured) {
    return <main className="auth-shell"><section className="auth-card setup-card">
      <div className="auth-card-top"><Logo /><LanguagePicker className="auth-language" /></div>
      <span className="eyebrow">{t("GET STARTED")}</span>
      <h1>{t("Connect your Supabase project")}</h1>
      <p>{t("The app server is running, but it needs Supabase settings before you can sign in.")}</p>
      <ol>
        <li>{t("Copy .env.example to .env.local.")}</li>
        <li>{t("Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.")}</li>
        <li>{t("Restart the dev server, then refresh this page.")}</li>
      </ol>
      <p>{t("See SUPABASE_SETUP.md for database setup instructions.")}</p>
    </section></main>;
  };

  if (loading) return <main className="auth-shell"><div className="auth-card"><div className="auth-card-top"><Logo /><LanguagePicker className="auth-language" /></div><p>{t("Loading your workspace...")}</p></div></main>;
  if (!session) return <AuthPage />;
  if (session.user.user_metadata?.team_invite_token && !session.user.user_metadata?.staff_password_set) return <PasswordSetupPage />;
  if (customerPortal) return <CustomerPortal
    portal={customerPortal}
    busy={busy}
    onSignOut={() => supabase.auth.signOut()}
    onRefresh={() => runCustomerOperation(() => Promise.resolve(), null)}
    onPlaceOrder={({ branchId: orderBranchId, items, note }) => runCustomerOperation(
      () => createCustomerOrder({ branchId: orderBranchId, items, note }),
      "Order request sent to the branch.",
    )}
    onSaveProfile={(values) => runCustomerOperation(
      () => updateCustomerProfile({ customerId: customerPortal.customer.id, ...values }),
      "Account details saved.",
    )}
  />;
  if (error && !workspace) return <main className="auth-shell"><div className="auth-card"><div className="auth-card-top"><Logo /><LanguagePicker className="auth-language" /></div><h1>{t("Workspace unavailable")}</h1><p className="form-error" role="alert">{t(error)}</p><Button variant="outline" onClick={() => supabase.auth.signOut()}>{t("Sign out")}</Button></div></main>;
  if (!workspace) return null;

  const { products, sales, branches, summary, expenses, team, customers, profile, organization } = workspace;
  const allowedPagesByRole = {
    admin: ["Dashboard", "Sales", "Products", "Inventory", "Expenses", "Reports", "Orders", "Users", "Branches", "Settings"],
    manager: ["Dashboard", "Sales", "Products", "Inventory", "Expenses", "Reports", "Orders"],
    cashier: ["Dashboard", "Sales", "Products", "Orders"],
    inventory_officer: ["Dashboard", "Products", "Inventory"],
  };
  const allowedPages = allowedPagesByRole[profile.role] || ["Dashboard"];
  const activePage = allowedPages.includes(page) ? page : "Dashboard";
  const canSell = ["admin", "manager", "cashier"].includes(profile.role);
  const canManageProducts = ["admin", "manager"].includes(profile.role);
  const canRestock = ["admin", "manager", "inventory_officer"].includes(profile.role);
  return <div className="app-shell">
    <Sidebar
      page={activePage}
      onNavigate={setPage}
      open={sidebarOpen}
      onClose={() => setSidebarOpen(false)}
      profile={profile}
      branches={branches}
      branchId={branchId}
      onBranchChange={setBranchId}
      lowStockCount={products.filter((product) => product.isLowStock ?? product.stock <= product.reorderLevel).length}
      onSignOut={() => supabase.auth.signOut()}
      allowedPages={allowedPages}
    />
    <main className="main-area">
      <Topbar page={activePage} onMenu={() => setSidebarOpen(true)} query={globalSearch} setQuery={setGlobalSearch} profile={profile} />
      {error && <div className="app-error" role="alert">{t(error)}</div>}
      {activePage === "Dashboard" ? <Dashboard products={products} sales={sales} branches={branches} summary={summary} expenses={expenses} profile={profile} onNavigate={setPage} currency={organization.currency} branchId={branchId} />
        : activePage === "Inventory" ? <InventoryPage products={products} onRestock={(product) => branchId === "all" ? notify("Select a branch to change inventory.") : setModal({ type: "restock", record: product })} currency={organization.currency} canRestock={canRestock} />
        : activePage === "Products" ? <ProductPage products={products} customers={customers} customerId={selectedCustomerId} setCustomerId={setSelectedCustomerId} branchId={branchId} onOpenModal={() => { setError(""); setModal({ type: "product" }); }} cart={cart} addToCart={addToCart} removeFromCart={removeFromCart} onCheckout={checkout} searchQuery={globalSearch} taxRate={organization.tax_rate} currency={organization.currency} paymentMethod={paymentMethod} setPaymentMethod={setPaymentMethod} busy={busy} canSell={canSell} canManageProducts={canManageProducts} />
        : activePage === "Orders" ? <OrdersPage orders={workspace.orders} currency={organization.currency} onUpdate={updateOrder} busy={busy} />
            : <GenericPage key={activePage} page={activePage} workspace={workspace} onOpenModal={openModal} onAssignBranch={(record) => { setError(""); setModal({ type: "assignBranch", record }); }} onEditMember={(record) => { setError(""); setModal({ type: "editUser", record }); }} onNavigate={setPage} onSaveSettings={saveSettings} busy={busy} />}
    </main>
    {modal && (["user", "assignBranch", "editUser"].includes(modal.type)
      ? <TeamMemberModal key={`${modal.type}-${modal.record?.id || "new"}`} type={modal.type} record={modal.record} branches={branches} onClose={() => setModal(null)} onSave={saveModal} onRemove={removeMember} error={error} busy={busy} />
      : <Modal type={modal.type} record={modal.record} branches={branches} branchId={branchId} onClose={() => setModal(null)} onSave={saveModal} busy={busy} />)}
    {toast && <div role="status" className="toast"><Check size={17} />{toast}</div>}
  </div>;
}

export default App;
