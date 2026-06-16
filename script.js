const state = {
  products: [],
  cart: [],
  selectedCategory: 'all',
  activeStockFilter: 'all',
  productSearch: '',
  inventorySearch: '',
  editingProductId: null,
  discountPercent: 0,
};

const fallbackImage = '/images/placeholder.svg';

function formatCurrency(value) {
  return `$${Number(value).toFixed(2)}`;
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toastMessage');
  toast.textContent = message;
  toast.className = `toast visible ${type}`;

  clearTimeout(window.toastTimeout);
  window.toastTimeout = setTimeout(() => {
    toast.className = 'toast hidden';
  }, 3200);
}

function toggleView(view) {
  const posPage = document.getElementById('posPage');
  const inventoryPage = document.getElementById('inventoryPage');

  if (view === 'inventory') {
    posPage.hidden = true;
    posPage.classList.remove('active');
    inventoryPage.hidden = false;
    inventoryPage.classList.add('active');
  } else {
    inventoryPage.hidden = true;
    inventoryPage.classList.remove('active');
    posPage.hidden = false;
    posPage.classList.add('active');
  }
}

function handleBarcodeKeydown(event) {
  if (event.key === 'Enter') {
    const barcode = event.target.value.trim();
    if (barcode) {
      scanBarcode(barcode);
      event.target.value = '';
    }
  }
}

function scanBarcode(barcode) {
  const product = state.products.find((item) => item.barcode === barcode || item.sku === barcode);
  if (product) {
    addToCart(product.id);
    showToast(`${product.name} added to cart`);
    return;
  }
  showToast('Barcode not found in inventory', 'danger');
}

const scannerState = {
  sessionId: null,
  socket: null,
  connected: false,
  phoneConnected: false,
  reconnectTimer: null,
};

function generateSessionId() {
  return `scanner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateScannerStatus(status, detail = '') {
  const statusText = document.getElementById('scannerStatusText');
  if (!statusText) return;
  statusText.textContent = status;
  statusText.className = status.toLowerCase().includes('connected') ? 'status-connected' : status.toLowerCase().includes('disconnected') ? 'status-disconnected' : '';
  document.getElementById('scannerDetails').classList.toggle('hidden', !scannerState.sessionId);
}

function createScannerQrCode(sessionId) {
  const qrContainer = document.getElementById('scannerQrCode');
  if (!qrContainer) return;
  qrContainer.innerHTML = '';
  const scanUrl = `${location.origin}/mobile-scanner.html?sessionId=${encodeURIComponent(sessionId)}`;
  if (window.QRCode) {
    new QRCode(qrContainer, {
      text: scanUrl,
      width: 240,
      height: 240,
      colorDark: '#111827',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    });
  } else {
    qrContainer.textContent = scanUrl;
  }
}

function renderScannerInfo() {
  const sessionText = document.getElementById('scannerSessionId');
  const details = document.getElementById('scannerDetails');
  if (scannerState.sessionId) {
    if (sessionText) sessionText.textContent = scannerState.sessionId;
    if (details) details.classList.remove('hidden');
    createScannerQrCode(scannerState.sessionId);
  } else if (details) {
    details.classList.add('hidden');
  }
}

function setScannerPanelCollapsed(collapsed) {
  const panel = document.querySelector('.scanner-panel');
  if (!panel) return;
  panel.classList.toggle('collapsed', collapsed);

  const details = document.getElementById('scannerDetails');
  if (!details) return;
  if (collapsed) {
    details.classList.add('hidden');
  } else {
    details.classList.toggle('hidden', !scannerState.sessionId);
  }
}

function handleScannerMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'device-status') {
    scannerState.phoneConnected = message.status === 'phone-connected';
    updateScannerStatus(scannerState.phoneConnected ? 'Phone connected' : 'Phone disconnected', 'Ready to scan once your phone is paired.');
    setScannerPanelCollapsed(scannerState.phoneConnected);
  } else if (message.type === 'barcode') {
    const barcode = String(message.barcode || '').trim();
    if (barcode) {
      scanBarcode(barcode);
      showToast(`Scanned barcode: ${barcode}`);
    }
  } else if (message.type === 'status') {
    updateScannerStatus(message.status, message.detail || '');
  }
}

function scheduleScannerReconnect() {
  if (!scannerState.sessionId) return;
  if (scannerState.reconnectTimer) return;
  scannerState.reconnectTimer = setTimeout(() => {
    scannerState.reconnectTimer = null;
    if (!scannerState.socket || scannerState.socket.readyState !== WebSocket.OPEN) {
      connectPhoneScanner();
    }
  }, 5000);
}

function connectPhoneScanner() {
  if (scannerState.socket && scannerState.socket.readyState === WebSocket.OPEN) {
    updateScannerStatus('Already connected', 'The pairing socket is already open.');
    return;
  }

  scannerState.sessionId = scannerState.sessionId || generateSessionId();
  renderScannerInfo();
  updateScannerStatus('Connecting...', 'Opening pairing channel...');

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socketUrl = `${protocol}://${location.host}/scanner-socket?role=pos&sessionId=${encodeURIComponent(scannerState.sessionId)}`;
  const socket = new WebSocket(socketUrl);
  scannerState.socket = socket;

  socket.addEventListener('open', () => {
    scannerState.connected = true;
    setScannerPanelCollapsed(false);
    updateScannerStatus('Connected', 'Waiting for phone to pair.');
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    handleScannerMessage(message);
  });

  socket.addEventListener('close', () => {
    scannerState.connected = false;
    scannerState.phoneConnected = false;
    updateScannerStatus('Disconnected', 'Pairing lost. Reconnecting...');
    scheduleScannerReconnect();
  });

  socket.addEventListener('error', () => {
    updateScannerStatus('Connection error', 'Unable to reach the scanner service.');
  });
}

function disconnectPhoneScanner() {
  if (scannerState.socket) {
    scannerState.socket.close();
  }
  scannerState.socket = null;
  scannerState.connected = false;
  scannerState.phoneConnected = false;
  scannerState.sessionId = null;
  if (scannerState.reconnectTimer) {
    clearTimeout(scannerState.reconnectTimer);
    scannerState.reconnectTimer = null;
  }
  setScannerPanelCollapsed(false);
  renderScannerInfo();
  updateScannerStatus('Disconnected', 'Phone scanner pairing ended.');
}

function setButtonActive(buttonGroup, activeValue) {
  buttonGroup.forEach((button) => {
    const value = button.dataset.value || button.textContent.trim().toLowerCase();
    button.classList.toggle('active', value === activeValue);
  });
}

function renderCategoryPills() {
  const categories = Array.from(new Set(state.products.map((product) => product.category.toLowerCase()))).sort();
  const pillsContainer = document.getElementById('categoryPills');
  pillsContainer.innerHTML = '';

  const createPill = (value, label) => {
    const button = document.createElement('button');
    button.className = 'pill';
    button.type = 'button';
    button.dataset.value = value;
    button.textContent = label;
    button.addEventListener('click', () => filterCategory(value));
    return button;
  };

  pillsContainer.appendChild(createPill('all', 'All Items'));
  categories.forEach((category) => {
    const label = category.replace(/\b\w/g, (chr) => chr.toUpperCase());
    pillsContainer.appendChild(createPill(category, label));
  });

  setButtonActive(Array.from(pillsContainer.querySelectorAll('.pill')), state.selectedCategory);
}

function renderProductGrid() {
  const grid = document.getElementById('productGrid');
  const products = state.products.filter((product) => {
    const categoryMatch = state.selectedCategory === 'all' || product.category.toLowerCase() === state.selectedCategory;
    const searchValue = state.productSearch.toLowerCase();
    const searchMatch = !searchValue || [product.name, product.sku, product.barcode, product.category].some((field) => String(field).toLowerCase().includes(searchValue));
    return categoryMatch && searchMatch;
  });

  grid.innerHTML = '';
  if (!products.length) {
    grid.innerHTML = '<div class="table-note">No products match your search or selected category.</div>';
    return;
  }

  products.forEach((product) => {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.innerHTML = `
      <img src="${product.image || fallbackImage}" alt="${product.name}" onerror="this.onerror=null;this.src='${fallbackImage}'" />
      <div class="product-card-body">
        <p class="product-label">${product.name}</p>
        <p class="product-meta">SKU: ${product.sku}</p>
        <div class="product-footer">
          <span class="price">${formatCurrency(product.price)}</span>
          <button class="quick-add-button" type="button">+ Add</button>
        </div>
      </div>
    `;

    card.querySelector('.quick-add-button').addEventListener('click', () => {
      addToCart(product.id);
      showToast(`${product.name} added to cart`);
    });
    grid.appendChild(card);
  });
}

function renderCart() {
  const cartContainer = document.getElementById('cartItemsContainer');
  const cartCount = document.getElementById('cartCount');
  const cartNote = document.getElementById('cartNote');
  const summary = calculateTotals();

  cartCount.textContent = `${state.cart.reduce((sum, item) => sum + item.quantity, 0)} items`;
  cartNote.textContent = state.cart.length ? 'Review the cart before payment.' : 'Add items from the left panel to build an order.';
  document.getElementById('subtotalAmount').textContent = formatCurrency(summary.subtotal);
  document.getElementById('discountAmount').textContent = formatCurrency(summary.discount);
  document.getElementById('taxAmount').textContent = formatCurrency(summary.tax);
  document.getElementById('totalAmount').textContent = formatCurrency(summary.total);

  // Keep discount input in sync if present
  const discountInput = document.getElementById('discountInput');
  if (discountInput) discountInput.value = String(state.discountPercent || 0);

  if (!state.cart.length) {
    cartContainer.innerHTML = '<div class="table-note">Your cart is empty. Add items from the product list to begin.</div>';
    return;
  }

  cartContainer.innerHTML = '';
  state.cart.forEach((item) => {
    const cartItem = document.createElement('article');
    cartItem.className = 'cart-item';
    cartItem.innerHTML = `
      <div>
        <p class="cart-item-name">${item.name}</p>
        <p class="cart-item-meta">${formatCurrency(item.unitPrice)} each</p>
      </div>
      <div class="cart-controls">
        <button type="button" class="qty-button">-</button>
        <span class="qty-value">${item.quantity}</span>
        <button type="button" class="qty-button">+</button>
      </div>
      <button class="remove-button" type="button" aria-label="Remove item">×</button>
    `;

    cartItem.querySelectorAll('.qty-button')[0].addEventListener('click', () => changeItemQuantity(item.productId, -1));
    cartItem.querySelectorAll('.qty-button')[1].addEventListener('click', () => changeItemQuantity(item.productId, 1));
    cartItem.querySelector('.remove-button').addEventListener('click', () => removeCartItem(item.productId));

    // Allow clicking the quantity value to edit it directly for large adjustments
    const qtyValueSpan = cartItem.querySelector('.qty-value');
    qtyValueSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = Number(item.quantity || 0);
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.value = String(current);
      input.className = 'qty-edit-input';
      input.style.width = '72px';
      input.style.padding = '8px';
      input.style.fontWeight = '700';
      input.style.textAlign = 'center';
      input.style.borderRadius = '10px';
      input.style.border = '1px solid rgba(0,0,0,0.08)';

      const commit = () => {
        let v = Number(input.value);
        if (!Number.isFinite(v) || Number.isNaN(v)) v = current;
        v = Math.max(0, Math.floor(v));
        if (v <= 0) {
          removeCartItem(item.productId);
        } else {
          const target = state.cart.find((c) => c.productId === item.productId);
          if (target) {
            target.quantity = v;
          }
          renderCart();
        }
      };

      const cancel = () => {
        renderCart();
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          commit();
        } else if (ev.key === 'Escape') {
          cancel();
        }
      });

      // Replace span with input for editing
      qtyValueSpan.replaceWith(input);
      input.focus();
      input.select();
    });
    cartContainer.appendChild(cartItem);
  });
}

function calculateTotals() {
  const subtotal = state.cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const discount = (Number(state.discountPercent || 0) / 100) * subtotal;
  const tax = Number(((subtotal - discount) * 0.08).toFixed(2));
  const total = Number((subtotal - discount + tax).toFixed(2));
  return { subtotal, discount, tax, total };
}

function addToCart(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) {
    showToast('Product not found in inventory', 'danger');
    return;
  }

  const cartItem = state.cart.find((item) => item.productId === productId);
  if (cartItem) {
    cartItem.quantity += 1;
  } else {
    state.cart.push({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      unitPrice: product.price,
      quantity: 1,
    });
  }

  renderCart();
}

function changeItemQuantity(productId, change) {
  const item = state.cart.find((entry) => entry.productId === productId);
  if (!item) return;
  item.quantity += change;
  if (item.quantity <= 0) {
    state.cart = state.cart.filter((entry) => entry.productId !== productId);
  }
  renderCart();
}

function removeCartItem(productId) {
  state.cart = state.cart.filter((item) => item.productId !== productId);
  renderCart();
}

function clearCart() {
  state.cart = [];
  renderCart();
  showToast('Cart cleared successfully');
}

function holdTransaction() {
  if (!state.cart.length) {
    showToast('No items to hold', 'danger');
    return;
  }
  showToast('Transaction held. Use the same cart to resume later.');
}

function fetchProducts() {
  const query = new URLSearchParams();
  if (state.selectedCategory && state.selectedCategory !== 'all') query.set('category', state.selectedCategory);
  const searchValue = state.inventorySearch || state.productSearch;
  if (searchValue) query.set('search', searchValue);
  if (state.activeStockFilter && state.activeStockFilter !== 'all') query.set('stock', state.activeStockFilter);

  return fetch(`/api/products?${query.toString()}`)
    .then((response) => response.json())
    .then((products) => {
      state.products = products;
      renderCategoryPills();
      renderProductGrid();
      renderInventoryTable();
      renderInventoryCards();
      renderCategoryList();
    })
    .catch((error) => {
      console.error('Unable to fetch products:', error);
      showToast('Unable to load products', 'danger');
    });
}

function searchProducts() {
  state.productSearch = document.getElementById('productSearchInput').value.trim();
  state.inventorySearch = document.getElementById('inventorySearch').value.trim();
  return fetchProducts();
}

function filterCategory(category) {
  state.selectedCategory = category;
  fetchProducts();
}

function filterStock(type) {
  state.activeStockFilter = type;
  document.querySelectorAll('#inventoryFilters .pill').forEach((button) => {
    const value = button.dataset.value || button.textContent.trim().toLowerCase().split(' ')[0];
    button.classList.toggle('active', value === type);
  });
  fetchProducts();
}

function renderInventoryTable() {
  const inventoryTable = document.getElementById('inventoryTableBody');
  const filteredProducts = state.products.filter((product) => {
    if (state.activeStockFilter === 'low') return product.stock > 0 && product.stock <= 10;
    if (state.activeStockFilter === 'out') return product.stock === 0;
    return true;
  });

  if (!filteredProducts.length) {
    inventoryTable.innerHTML = '<tr><td class="table-note" colspan="7">No inventory items match these filters.</td></tr>';
    return;
  }

  inventoryTable.innerHTML = filteredProducts
    .map((product) => `
      <tr>
        <td><img class="table-image" src="${product.image || fallbackImage}" alt="${product.name}" onerror="this.onerror=null;this.src='${fallbackImage}'" /></td>
        <td>${product.name}</td>
        <td>${product.category}</td>
        <td>${product.sku} / ${product.barcode}</td>
        <td>${formatCurrency(product.price)}</td>
        <td>${product.stock}</td>
        <td class="table-actions">
          <button class="table-button" type="button" onclick="editProduct('${product.id}')">Edit</button>
          <button class="table-button danger" type="button" onclick="deleteProduct('${product.id}')">Delete</button>
        </td>
      </tr>
    `)
    .join('');
}

function renderInventoryCards() {
  document.getElementById('totalProductsCount').textContent = state.products.length;
  const uniqueCategories = new Set(state.products.map((product) => product.category.trim().toLowerCase()));
  document.getElementById('totalCategoriesCount').textContent = uniqueCategories.size;
  document.getElementById('lowStockCount').textContent = state.products.filter((product) => product.stock > 0 && product.stock <= 10).length;
  document.getElementById('outOfStockCount').textContent = state.products.filter((product) => product.stock === 0).length;
}

function renderCategoryList() {
  const categoryList = document.getElementById('categoryList');
  const categories = Array.from(new Set(state.products.map((product) => product.category.trim()).filter(Boolean))).sort();
  categoryList.innerHTML = categories
    .map((category) => `<button class="category-chip" type="button">${category}</button>`)
    .join('');
}

function openAddProductModal(product = null) {
  const modal = document.getElementById('productModal');
  const title = document.getElementById('modalTitle');
  state.editingProductId = product ? product.id : null;

  title.textContent = product ? 'Edit inventory item' : 'New inventory item';
  document.getElementById('productImageUrl').value = product?.image || '';
  document.getElementById('productName').value = product?.name || '';
  document.getElementById('productDescription').value = product?.description || '';
  document.getElementById('productCategory').value = product?.category || '';
  document.getElementById('productSku').value = product?.sku || '';
  document.getElementById('productCost').value = product?.cost || '';
  document.getElementById('productPrice').value = product?.price || '';
  document.getElementById('productStock').value = product?.stock ?? '';
  document.getElementById('productThreshold').value = product?.threshold ?? '';
  const preview = document.getElementById('imagePreview');
  if (product?.image) {
    preview.style.backgroundImage = `url('${product.image}')`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.textContent = '';
  } else {
    preview.style.backgroundImage = 'none';
    preview.textContent = 'Image preview';
  }
  modal.classList.remove('hidden');
}

function closeProductModal() {
  document.getElementById('productModal').classList.add('hidden');
  document.getElementById('addProductForm').reset();
  const preview = document.getElementById('imagePreview');
  preview.style.backgroundImage = 'none';
  preview.textContent = 'Image preview';
  state.editingProductId = null;
}

function previewProductImage(event) {
  const preview = document.getElementById('imagePreview');
  const file = event.target.files && event.target.files[0];

  if (!file) {
    preview.textContent = 'Image preview';
    preview.style.backgroundImage = 'none';
    return;
  }

  const reader = new FileReader();
  reader.onload = function () {
    // Use the base64 data URI only for the live preview in the browser.
    // Do NOT persist base64 data URIs into the product record or SQLite database.
    // A proper image upload endpoint should be implemented to store files
    // on disk (e.g. /images) or in cloud storage and save a URL instead.
    preview.style.backgroundImage = `url('${reader.result}')`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.textContent = '';
  };
  reader.readAsDataURL(file);
}

function saveProduct() {
  const payload = {
    name: document.getElementById('productName').value.trim(),
    description: document.getElementById('productDescription').value.trim(),
    category: document.getElementById('productCategory').value.trim(),
    sku: document.getElementById('productSku').value.trim(),
    barcode: document.getElementById('productSku').value.trim(),
    price: Number(document.getElementById('productPrice').value) || 0,
    stock: Number(document.getElementById('productStock').value) || 0,
    cost: Number(document.getElementById('productCost').value) || 0,
    threshold: Number(document.getElementById('productThreshold').value) || 0,
    // Don't persist base64 data URIs into SQLite. If the user pasted a
    // data:image/... base64 string into the Image URL field, ignore it and
    // fall back to the placeholder. A real image upload endpoint should be
    // implemented to save uploaded files to the /images folder or cloud
    // storage and then save the resulting URL here instead.
    image: (function () {
      const url = document.getElementById('productImageUrl').value.trim();
      if (!url) return fallbackImage;
      if (url.startsWith('data:')) return fallbackImage; // ignore base64 data URIs
      return url;
    })(),
  };

  if (!payload.name || !payload.category || !payload.sku) {
    showToast('Product name, category, and SKU are required.', 'danger');
    return;
  }

  const url = state.editingProductId ? `/api/products/${state.editingProductId}` : '/api/products';
  const method = state.editingProductId ? 'PUT' : 'POST';

  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((response) => response.json())
    .then((result) => {
      if (result.error) {
        throw new Error(result.error);
      }
      showToast(state.editingProductId ? 'Product updated successfully' : 'Product saved successfully');
      closeProductModal();
      loadProducts();
    })
    .catch((error) => {
      console.error('Save failed:', error);
      showToast(error.message || 'Unable to save product', 'danger');
    });
}

function editProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) {
    showToast('Product not found', 'danger');
    return;
  }
  openAddProductModal(product);
}

function deleteProduct(id) {
  if (!confirm('Delete this product from inventory?')) return;

  fetch(`/api/products/${id}`, { method: 'DELETE' })
    .then((response) => response.json())
    .then((result) => {
      if (result.error) {
        throw new Error(result.error);
      }
      showToast('Product removed from inventory');
      loadProducts();
    })
    .catch((error) => {
      console.error('Delete failed:', error);
      showToast(error.message || 'Unable to delete product', 'danger');
    });
}

function processPayment(paymentMethod) {
  if (!state.cart.length) {
    showToast('Cart is empty. Add products before checkout.', 'danger');
    return;
  }

  const payload = {
    paymentMethod,
    discountPercent: Number(state.discountPercent || 0),
    items: state.cart.map((item) => ({
      productId: item.productId,
      name: item.name,
      sku: item.sku,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
    })),
  };

  fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((response) => response.json())
    .then((result) => {
      if (result.error) {
        throw new Error(result.error);
      }
      clearCart();
      showToast(`Payment successful: ${paymentMethod}. Total ${formatCurrency(result.total)}`);
    })
    .catch((error) => {
      console.error('Checkout failed:', error);
      showToast(error.message || 'Payment failed', 'danger');
    });
}

function processCashPayment() {
  processPayment('Cash');
}

function processCardPayment() {
  processPayment('Card');
}

function processDigitalWalletPayment() {
  processPayment('Digital Wallet');
}

function loadProducts() {
  return fetchProducts();
}

window.addEventListener('DOMContentLoaded', () => {
  const inventoryButton = document.getElementById('inventoryButton');
  if (inventoryButton) {
    inventoryButton.addEventListener('click', () => toggleView('inventory'));
  }
  document.getElementById('productSearchInput').addEventListener('input', searchProducts);
  document.getElementById('inventorySearch').addEventListener('input', searchProducts);
  document.getElementById('connectScannerButton')?.addEventListener('click', connectPhoneScanner);
  document.getElementById('disconnectScannerButton')?.addEventListener('click', disconnectPhoneScanner);
  // Discount input binding (if present)
  const discountInput = document.getElementById('discountInput');
  if (discountInput) {
    discountInput.addEventListener('input', (e) => {
      let v = Number(e.target.value);
      if (Number.isNaN(v)) v = 0;
      v = Math.max(0, Math.min(100, v));
      state.discountPercent = v;
      renderCart();
    });
  }
  renderScannerInfo();
  loadProducts();
});
