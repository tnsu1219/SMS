import { supabase } from "./supabase";

function unwrap(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function teamRequest(body) {
  const { data, error } = await supabase.functions.invoke("team-members", { body });
  if (error) {
    if (error.context instanceof Response) {
      let details;
      try {
        details = await error.context.clone().json();
      } catch {
        throw error;
      }
      if (typeof details?.error === "string") throw new Error(details.error);
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function loadTeamMembers(profile, userId) {
  if (profile.role !== "admin") {
    const member = unwrap(await supabase.from("profiles")
      .select("id, full_name, email, role, branch_id")
      .eq("id", userId)
      .single());
    return { team: [member], teamManagementError: "" };
  }

  try {
    const result = await teamRequest({ action: "list" });
    return { team: result.team, teamManagementError: "" };
  } catch (error) {
    const status = error?.context?.status || error?.status;
    const functionUnavailable = /Failed to send a request to the Edge Function/i.test(error?.message || "") || status === 404;
    if (!functionUnavailable) throw error;
    const members = unwrap(await supabase.from("profiles")
      .select("id, full_name, email, role, branch_id")
      .eq("organization_id", profile.organization_id)
      .order("full_name"));
    return {
      team: members.map((member) => ({ ...member, status: "unknown" })),
      teamManagementError: status === 404
        ? "The team-management Edge Function is not deployed to this Supabase project."
        : error.message,
    };
  }
}

const categoryImages = {
  Bakery: "🍞",
  Beverages: "☕",
  Dairy: "🥛",
  Snacks: "🍫",
};

const categoryColors = {
  Bakery: "yellow",
  Beverages: "peach",
  Dairy: "mint",
  Snacks: "lavender",
};

export async function loadWorkspace(userId, requestedBranchId) {
  const profile = unwrap(await supabase
    .from("profiles")
    .select("id, organization_id, branch_id, full_name, email, role")
    .eq("id", userId)
    .single());

  const branches = unwrap(await supabase
    .from("branches")
    .select("id, name, address, active")
    .eq("organization_id", profile.organization_id)
    .eq("active", true)
    .order("name"));

  const allBranches = profile.role === "admin" && requestedBranchId === "all";
  const branchId = profile.role === "admin"
    ? allBranches ? "all" : requestedBranchId || profile.branch_id || branches[0]?.id
    : profile.branch_id;
  if (!branchId || (!allBranches && !branches.some((branch) => branch.id === branchId)) || (allBranches && branches.length === 0)) {
    throw new Error("No accessible branch is available for this account.");
  }
  const branchIds = allBranches ? branches.map((branch) => branch.id) : [branchId];

  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);

  const [organizationResult, productsResult, inventoryResult, salesResult, expensesResult, teamResult, customersResult, ordersResult] = await Promise.all([
    supabase.from("organizations").select("name, tax_rate, currency").eq("id", profile.organization_id).single(),
    supabase.from("products").select("id, sku, name, category, price, cost, active, brand, model, color, storage_gb").eq("organization_id", profile.organization_id).eq("active", true).order("name"),
    supabase.from("inventory").select("branch_id, product_id, quantity, reorder_level").in("branch_id", branchIds),
    supabase.from("sales").select("id, receipt_number, customer_name, payment_method, total, status, created_at, cashier_id, branch_id").in("branch_id", branchIds).order("created_at", { ascending: false }).limit(100),
    supabase.from("expenses").select("id, title, category, amount, incurred_on, created_at, created_by, branch_id").in("branch_id", branchIds).order("created_at", { ascending: false }).limit(100),
    loadTeamMembers(profile, userId),
    supabase.from("customers").select("id, name, email, phone").order("name").limit(1000),
    supabase.from("customer_orders").select("id, customer_id, branch_id, status, note, subtotal, tax, total, sales_id, created_at").order("created_at", { ascending: false }).limit(200),
  ]);

  const organization = unwrap(organizationResult);
  const inventory = unwrap(inventoryResult);
  const customers = unwrap(customersResult);
  const rawOrders = unwrap(ordersResult);
  const orderItemResult = rawOrders.length
    ? await supabase.from("customer_order_items")
      .select("order_id, product_name, quantity, unit_price, line_total")
      .in("order_id", rawOrders.map((order) => order.id))
    : { data: [], error: null };
  const itemsByOrder = new Map();
  unwrap(orderItemResult).forEach((item) => {
    const items = itemsByOrder.get(item.order_id) || [];
    items.push(item);
    itemsByOrder.set(item.order_id, items);
  });
  const branchesById = new Map(branches.map((branch) => [branch.id, branch.name]));
  const customersById = new Map(customers.map((customer) => [customer.id, customer.name]));
  const orders = rawOrders.map((order) => ({
    ...order,
    subtotal: Number(order.subtotal),
    tax: Number(order.tax),
    total: Number(order.total),
    customerName: customersById.get(order.customer_id) || "Customer",
    branchName: branchesById.get(order.branch_id) || "Branch",
    items: itemsByOrder.get(order.id) || [],
  }));
  const summaryResults = await Promise.all(branchIds.map((id) => supabase.rpc("get_dashboard_summary", {
    p_branch_id: id,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  })));
  const namesByBranchId = new Map(branches.map((branch) => [branch.id, branch.name]));
  const stockByProduct = new Map();
  inventory.forEach((row) => {
    const stockRows = stockByProduct.get(row.product_id) || [];
    stockRows.push(row);
    stockByProduct.set(row.product_id, stockRows);
  });
  const products = unwrap(productsResult).map((product) => {
    const stockRows = stockByProduct.get(product.id) || [];
    const stock = stockRows.reduce((total, row) => total + row.quantity, 0);
    const reorderLevel = allBranches
      ? stockRows.reduce((total, row) => total + row.reorder_level, 0)
      : stockRows[0]?.reorder_level ?? 0;
    const lowStockBranches = stockRows
      .filter((row) => row.quantity <= row.reorder_level)
      .map((row) => namesByBranchId.get(row.branch_id));
    return {
      ...product,
      price: Number(product.price),
      cost: Number(product.cost),
      deviceColor: product.color,
      storageGb: product.storage_gb,
      stock,
      reorderLevel,
      branchStocks: stockRows.map((row) => ({
        branchId: row.branch_id,
        branchName: namesByBranchId.get(row.branch_id) || "Branch",
        quantity: row.quantity,
      })),
      isLowStock: allBranches ? lowStockBranches.length > 0 : stock <= reorderLevel,
      lowStockBranches,
      image: categoryImages[product.category] || "📦",
      color: categoryColors[product.category] || "blue",
    };
  });

  const team = teamResult.team;
  const teamById = new Map(team.map((member) => [member.id, member.full_name]));
  const sales = unwrap(salesResult).map((sale) => ({
    id: sale.receipt_number,
    customer: sale.customer_name,
    branch: namesByBranchId.get(sale.branch_id) || "Branch",
    date: sale.created_at,
    method: ({ cash: "Cash", card: "Card", mobile: "Mobile pay" })[sale.payment_method] || sale.payment_method,
    amount: Number(sale.total),
    status: sale.status === "completed" ? "Completed" : sale.status,
    cashier: teamById.get(sale.cashier_id) || "Team member",
  }));
  const expenses = unwrap(expensesResult).map((expense) => ({
    id: expense.id.slice(0, 8).toUpperCase(),
    customer: expense.title,
    branch: namesByBranchId.get(expense.branch_id) || "Branch",
    date: expense.incurred_on,
    method: expense.category,
    amount: Number(expense.amount),
    status: "Completed",
    createdBy: teamById.get(expense.created_by) || "Team member",
  }));

  const summary = summaryResults
    .map((result) => unwrap(result)[0])
    .filter(Boolean)
    .reduce((total, row) => ({
      sales_count: total.sales_count + Number(row.sales_count || 0),
      revenue: total.revenue + Number(row.revenue || 0),
      gross_profit: total.gross_profit + Number(row.gross_profit || 0),
      expenses: total.expenses + Number(row.expenses || 0),
    }), { sales_count: 0, revenue: 0, gross_profit: 0, expenses: 0 });

  return {
    profile,
    organization,
    branches,
    branchId,
    products,
    sales,
    expenses,
    team,
    customers,
    orders,
    teamManagementError: teamResult.teamManagementError,
    summary,
  };
}

export async function listCustomerSignupOrganizations() {
  return unwrap(await supabase.rpc("list_customer_signup_organizations"));
}

export async function loadCustomerPortal(userId) {
  const customer = unwrap(await supabase.from("customers")
    .select("id, organization_id, name, email, phone, address")
    .eq("auth_user_id", userId)
    .single());
  const [organizationResult, branchesResult, productsResult, inventoryResult, ordersResult, salesResult] = await Promise.all([
    supabase.from("organizations").select("id, name, currency, tax_rate").eq("id", customer.organization_id).single(),
    supabase.from("branches").select("id, name, address").eq("organization_id", customer.organization_id).eq("active", true).order("name"),
    supabase.from("products").select("id, sku, name, category, price, brand, model, color, storage_gb").eq("organization_id", customer.organization_id).eq("active", true).order("name"),
    supabase.from("inventory").select("branch_id, product_id, quantity").eq("organization_id", customer.organization_id),
    supabase.from("customer_orders").select("id, branch_id, status, note, subtotal, tax, total, sales_id, created_at").eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(100),
    supabase.from("sales").select("id, receipt_number, branch_id, customer_name, payment_method, subtotal, tax, total, status, created_at").eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(100),
  ]);
  const organization = unwrap(organizationResult);
  const branches = unwrap(branchesResult);
  const inventory = unwrap(inventoryResult);
  const productRows = unwrap(productsResult);
  const rawOrders = unwrap(ordersResult);
  const salesRows = unwrap(salesResult);
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  const stockByProduct = new Map();
  inventory.forEach((row) => {
    stockByProduct.set(row.product_id, (stockByProduct.get(row.product_id) || 0) + Number(row.quantity));
  });
  const products = productRows.map((product) => ({
    ...product,
    price: Number(product.price),
    storageGb: product.storage_gb,
    deviceColor: product.color,
    stock: stockByProduct.get(product.id) || 0,
    branchStocks: inventory
      .filter((row) => row.product_id === product.id)
      .map((row) => ({ branchId: row.branch_id, quantity: Number(row.quantity) })),
    image: categoryImages[product.category] || "📦",
    color: categoryColors[product.category] || "blue",
  }));

  const orderIds = rawOrders.map((order) => order.id);
  const saleIds = salesRows.map((sale) => sale.id);
  const [orderItemsResult, saleItemsResult] = await Promise.all([
    orderIds.length
      ? supabase.from("customer_order_items").select("order_id, product_name, quantity, unit_price, line_total").in("order_id", orderIds)
      : Promise.resolve({ data: [], error: null }),
    saleIds.length
      ? supabase.from("sale_items").select("sale_id, quantity, unit_price, line_total, products(name)").in("sale_id", saleIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const orderItemsById = new Map();
  unwrap(orderItemsResult).forEach((item) => {
    const items = orderItemsById.get(item.order_id) || [];
    items.push(item);
    orderItemsById.set(item.order_id, items);
  });
  const saleItemsById = new Map();
  unwrap(saleItemsResult).forEach((item) => {
    const items = saleItemsById.get(item.sale_id) || [];
    items.push(item);
    saleItemsById.set(item.sale_id, items);
  });
  return {
    customer,
    organization,
    branches,
    products,
    orders: rawOrders.map((order) => ({
      ...order,
      subtotal: Number(order.subtotal),
      tax: Number(order.tax),
      total: Number(order.total),
      branchName: branchNames.get(order.branch_id) || "Branch",
      items: orderItemsById.get(order.id) || [],
    })),
    purchases: salesRows.map((sale) => ({
      ...sale,
      subtotal: Number(sale.subtotal),
      tax: Number(sale.tax),
      total: Number(sale.total),
      branchName: branchNames.get(sale.branch_id) || "Branch",
      items: saleItemsById.get(sale.id) || [],
    })),
  };
}

export async function updateCustomerProfile({ customerId, name, phone, address }) {
  return unwrap(await supabase.from("customers").update({
    name,
    phone: phone || null,
    address: address || null,
  }).eq("id", customerId).select("id").single());
}

export async function createCustomerOrder({ branchId, items, note }) {
  return unwrap(await supabase.rpc("create_customer_order", {
    p_branch_id: branchId,
    p_items: items.map(({ id, quantity }) => ({ product_id: id, quantity })),
    p_note: note || null,
  }));
}

export async function updateCustomerOrderStatus({ orderId, status, paymentMethod }) {
  return unwrap(await supabase.rpc("update_customer_order_status", {
    p_order_id: orderId,
    p_status: status,
    p_payment_method: paymentMethod || null,
  }));
}

export async function createProduct({ branchId, sku, name, category, price, cost, quantity, reorderLevel, brand, model, color, storageGb }) {
  return unwrap(await supabase.rpc("create_product_with_details", {
    p_branch_id: branchId,
    p_sku: sku,
    p_name: name,
    p_category: category,
    p_price: price,
    p_cost: cost,
    p_initial_quantity: quantity,
    p_reorder_level: reorderLevel,
    p_brand: brand || null,
    p_model: model || null,
    p_color: color || null,
    p_storage_gb: storageGb ? Number(storageGb) : null,
  }));
}

export async function adjustStock({ branchId, productId, quantityDelta, reorderLevel }) {
  return unwrap(await supabase.rpc("adjust_stock", {
    p_branch_id: branchId,
    p_product_id: productId,
    p_quantity_delta: quantityDelta,
    p_reorder_level: reorderLevel,
  }));
}

export async function createSale({ branchId, items, paymentMethod, customerId, customerName }) {
  return unwrap(await supabase.rpc("create_sale", {
    p_branch_id: branchId,
    p_items: items.map(({ id, quantity }) => ({ product_id: id, quantity })),
    p_payment_method: paymentMethod,
    p_customer_name: customerName || null,
    p_customer_id: customerId || null,
  }));
}

export async function createExpense({ organizationId, branchId, userId, title, category, amount }) {
  return unwrap(await supabase.from("expenses").insert({
    organization_id: organizationId,
    branch_id: branchId,
    created_by: userId,
    title,
    category,
    amount,
  }).select("id").single());
}

export async function createBranch({ organizationId, name, address }) {
  return unwrap(await supabase.from("branches").insert({
    organization_id: organizationId,
    name,
    address,
  }).select("id").single());
}

export async function updateOrganization({ organizationId, name, taxRate, currency }) {
  return unwrap(await supabase.from("organizations").update({
    name,
    tax_rate: taxRate,
    currency,
  }).eq("id", organizationId).select("id").single());
}

export async function inviteTeamMember({ fullName, email, password, role, branchId }) {
  return teamRequest({ action: "invite", fullName, email, password, role, branchId });
}

export async function assignTeamMemberBranch({ userId, branchId }) {
  return teamRequest({ action: "assign-branch", userId, branchId });
}

export async function updateTeamMember({ userId, fullName, role, branchId }) {
  return teamRequest({ action: "update", userId, fullName, role, branchId });
}

export async function removeTeamMember({ userId }) {
  return teamRequest({ action: "remove", userId });
}
