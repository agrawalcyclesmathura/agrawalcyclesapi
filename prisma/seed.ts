import { PrismaClient, ProductStatus } from "@prisma/client";

const prisma = new PrismaClient();

// Fine-grained permissions.
const PERMISSIONS = [
  "dashboard:view",
  "products:view", "products:create", "products:edit", "products:delete",
  "orders:view", "orders:edit", "orders:refund", "orders:delete",
  "customers:view", "customers:edit",
  "inventory:view", "inventory:edit",
  "coupons:view", "coupons:manage",
  "reviews:view", "reviews:moderate",
  "analytics:view", "content:manage", "marketing:manage",
  "reports:view", "reports:export", "settings:manage",
  "users:manage", "system:manage",
  // CMS resources
  "media:view", "media:manage",
  "banners:view", "banners:manage",
  "categories:view", "categories:manage",
  "brands:view", "brands:manage",
  "testimonials:manage", "team:manage",
  "pages:manage", "menus:manage", "faq:manage", "blog:manage",
  "stores:manage", "home:manage",
  "newsletter:view", "newsletter:manage",
  "contact:view", "contact:manage",
  "roles:manage",
];

const ROLES: { slug: string; name: string; perms: string[] | "*" }[] = [
  { slug: "super_admin", name: "Super Admin", perms: "*" },
  { slug: "manager", name: "Manager", perms: [
    "dashboard:view", "products:view", "products:create", "products:edit",
    "orders:view", "orders:edit", "customers:view", "inventory:view",
    "coupons:view", "coupons:manage", "reviews:view", "reviews:moderate",
    "analytics:view", "reports:view", "reports:export",
  ]},
  { slug: "product_manager", name: "Product Manager", perms: [
    "dashboard:view", "products:view", "products:create", "products:edit", "products:delete", "inventory:view",
  ]},
  { slug: "viewer", name: "Viewer", perms: PERMISSIONS.filter((p) => p.endsWith(":view")) },
  { slug: "customer", name: "Customer", perms: [] },
];

const catImg = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=800&q=80`;
const CATEGORIES = [
  { name: "Mountain Bikes", slug: "mountain-bikes", position: 0, isFeatured: true,
    description: "Conquer any trail with rugged, high-performance mountain bikes built for control and durability.",
    imageUrl: catImg("1576435728678-68d0fbf94e91") },
  { name: "Road Bikes", slug: "road-bikes", position: 1, isFeatured: true,
    description: "Lightweight, aerodynamic road bikes engineered for speed on the open road.",
    imageUrl: catImg("1485965120184-e220f721d03e") },
  { name: "Electric Bikes", slug: "electric-bikes", position: 2, isFeatured: true,
    description: "Ride further with less effort on our premium range of e-bikes and city cruisers.",
    imageUrl: catImg("1571333250630-f0230c320b6d") },
  { name: "Bicycle Parts", slug: "bicycle-parts", position: 3, isFeatured: true,
    description: "Frames, forks, drivetrains and everything you need to build or upgrade your ride.",
    imageUrl: catImg("1559348349-86f1f65817fe") },
  { name: "Accessories", slug: "accessories", position: 4, isFeatured: false,
    description: "Lights, locks, bells and gear to complete your cycling setup.",
    imageUrl: catImg("1615486511484-92e172cc4fe0") },
  { name: "Helmets", slug: "helmets", position: 5, isFeatured: false,
    description: "Protect every ride with certified, comfortable helmets.",
    imageUrl: catImg("1502744688674-c619d1586c9e") },
];

const BRANDS = [
  { name: "Cube", isFeatured: true }, { name: "Trek", isFeatured: true },
  { name: "Giant", isFeatured: true }, { name: "Cannondale", isFeatured: true },
  { name: "Specialized", isFeatured: true }, { name: "Shimano", isFeatured: true },
  { name: "Bell", isFeatured: false }, { name: "Merida", isFeatured: false },
];

const PRODUCTS = [
  { name: "Cube Stereo Hybrid 120 E-Bike", cat: "electric-bikes", brand: "Cube", mrp: 2600, price: 2450 },
  { name: "Mondraker Chaser RX Trail Bike", cat: "mountain-bikes", brand: "Merida", mrp: 2100, price: 1890 },
  { name: "Trek Domane SL Road Bicycle", cat: "road-bikes", brand: "Trek", mrp: 1700, price: 1620 },
  { name: "Giant Escape 3 City Bike", cat: "road-bikes", brand: "Giant", mrp: 480, price: 430 },
  { name: "Cannondale Trail Neo E-MTB", cat: "electric-bikes", brand: "Cannondale", mrp: 1200, price: 1020 },
  { name: "Specialized Rockhopper Comp 29", cat: "mountain-bikes", brand: "Specialized", mrp: 950, price: 890 },
  { name: "BELL Avenue LED Adult Helmet", cat: "helmets", brand: "Bell", mrp: 300, price: 280 },
  { name: "Shimano GRX RX812 Derailleur", cat: "bicycle-parts", brand: "Shimano", mrp: 360, price: 320 },
];

async function main() {
  console.log("Seeding…");

  // Permissions + roles
  await prisma.permission.createMany({
    data: PERMISSIONS.map((key) => {
      const [resource, action] = key.split(":");
      return { key, resource, action };
    }),
    skipDuplicates: true,
  });
  const allPerms = await prisma.permission.findMany();

  for (const role of ROLES) {
    const created = await prisma.role.upsert({
      where: { slug: role.slug },
      update: {},
      create: { slug: role.slug, name: role.name, isSystem: true },
    });
    const keys = role.perms === "*" ? PERMISSIONS : role.perms;
    await prisma.rolePermission.createMany({
      data: allPerms
        .filter((p) => keys.includes(p.key))
        .map((p) => ({ roleId: created.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  // Bootstrap super_admin — NO local password. Administrators sign in via
  // Firebase; the account whose email matches ADMIN_BOOTSTRAP_EMAIL is
  // auto-provisioned as super_admin on first Firebase sign-in (see AuthService).
  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { slug: "super_admin" } });
  const bootstrapEmail = (process.env.ADMIN_BOOTSTRAP_EMAIL ?? "admin@agrawalcycles.com").toLowerCase();
  const admin = await prisma.user.upsert({
    where: { email: bootstrapEmail },
    update: {},
    create: {
      email: bootstrapEmail,
      firstName: "Store",
      lastName: "Owner",
      type: "STAFF",
      emailVerified: true,
      adminStatus: "APPROVED",
    },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: superAdmin.id } },
    update: {},
    create: { userId: admin.id, roleId: superAdmin.id },
  });

  // Warehouse
  const warehouse = await prisma.warehouse.upsert({
    where: { code: "WH-NY" },
    update: {},
    create: { name: "New York DC", code: "WH-NY", city: "New York", state: "NY" },
  });

  // Categories + brands
  const catMap = new Map<string, string>();
  for (const c of CATEGORIES) {
    const { slug, ...rest } = c;
    const created = await prisma.category.upsert({
      where: { slug }, update: rest, create: c,
    });
    catMap.set(slug, created.id);
  }
  const brandMap = new Map<string, string>();
  let bpos = 0;
  for (const b of BRANDS) {
    const slug = b.name.toLowerCase();
    const data = {
      name: b.name,
      description: `Premium cycling gear from ${b.name}.`,
      isFeatured: b.isFeatured,
      position: bpos++,
    };
    const created = await prisma.brand.upsert({
      where: { slug }, update: data, create: { ...data, slug },
    });
    brandMap.set(b.name, created.id);
  }

  // Products + inventory
  let i = 0;
  const IMG_POOL = [
    "1485965120184-e220f721d03e", "1571068316344-75bc76f77890", "1532298229144-0ec0c57515c7",
    "1511994298241-608e28f14fde", "1576435728678-68d0fbf94e91", "1559348349-86f1f65817fe",
  ];
  const pimg = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=800&q=80`;
  for (const p of PRODUCTS) {
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const gallery = [0, 2, 4].map((off, k) => ({ url: pimg(IMG_POOL[(i + off) % IMG_POOL.length]), position: k }));
    const productData = {
      sku: `PW-${1000 + i}`,
      name: p.name,
      slug,
      shortDescription: `Premium ${p.name} — engineered for performance and built to last.`,
      description:
        "Engineered for performance and built to last, this model blends premium materials with precision components for a smooth, confident and responsive ride every time.",
      mrp: p.mrp,
      price: p.price,
      salePrice: i % 3 === 0 ? Math.round(p.price * 0.9) : null,
      taxRate: 18,
      status: ProductStatus.PUBLISHED,
      isFeatured: i < 4,
      isBestSeller: i % 2 === 0,
      isNewArrival: i >= PRODUCTS.length - 3,
      isTrending: i % 4 === 1,
      position: i,
      warranty: "2 Years",
      features: [
        "Lightweight yet durable frame construction",
        "Precision-tuned components for a smooth ride",
        "Reliable braking and confident handling",
      ],
      specifications: [
        { label: "Brand", value: p.brand },
        { label: "Warranty", value: "2 Years" },
        { label: "Frame Material", value: "Aluminium Alloy" },
      ],
      categoryId: catMap.get(p.cat),
      brandId: brandMap.get(p.brand),
    };
    const product = await prisma.product.upsert({
      where: { slug },
      update: {
        ...productData,
        images: { deleteMany: {}, create: gallery },
      },
      create: { ...productData, images: { create: gallery } },
    });
    await prisma.inventoryItem.upsert({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      update: {},
      create: { productId: product.id, warehouseId: warehouse.id, quantity: 25 },
    });
    i++;
  }

  // Site settings (CMS) — seeded with the values currently shown on the storefront.
  const SETTINGS: { key: string; group: string; value: Record<string, unknown> }[] = [
    { key: "general", group: "public", value: {
      siteName: "Agrawal Cycles",
      tagline: "Mathura's trusted bicycle store",
      logoUrl: "",
      faviconUrl: "",
    }},
    { key: "contact", group: "public", value: {
      email: "info@agrawalcycles.com",
      phone: "+91 90000 00000",
      whatsapp: "+91 90000 00000",
      address: "Mathura, Uttar Pradesh 281001",
    }},
    { key: "social", group: "public", value: {
      facebook: "", instagram: "", youtube: "", twitter: "", whatsapp: "",
    }},
    { key: "commerce", group: "public", value: {
      currency: "INR", currencySymbol: "₹", taxPercent: 18,
      shippingFlat: 0, freeShippingThreshold: 0,
    }},
    { key: "seo", group: "public", value: {
      metaTitle: "Agrawal Cycles — Premium Bicycles in Mathura",
      metaDesc: "Buy premium bicycles, e-bikes, parts and accessories from Agrawal Cycles, Mathura.",
      ogImageUrl: "",
    }},
    { key: "features", group: "public", value: {
      maintenanceMode: false, announcementBar: true,
    }},
    { key: "analytics", group: "public", value: {
      googleAnalyticsId: "", metaPixelId: "",
    }},
    { key: "smtp", group: "private", value: {
      host: "", port: 587, user: "", pass: "", from: "Agrawal Cycles <no-reply@agrawalcycles.com>",
    }},
  ];
  for (const s of SETTINGS) {
    await prisma.setting.upsert({
      where: { key: s.key },
      update: {}, // never overwrite admin-edited settings on re-seed
      create: { key: s.key, value: s.value as object, group: s.group },
    });
  }

  // Homepage hero banners (migrated from the hardcoded storefront slides).
  const BANNERS = [
    {
      eyebrow: "New Season 2026",
      title: "Ride Beyond Limits",
      subtitle: "Premium bicycles engineered for every terrain.",
      imageUrl: "https://images.unsplash.com/photo-1485965120184-e220f721d03e?w=1600",
      linkUrl: "/shop",
      buttonText: "Shop Now",
      placement: "hero",
      position: 0,
    },
    {
      eyebrow: "Electric Range",
      title: "Power Your Commute",
      subtitle: "Explore our latest e-bikes with extended battery life.",
      imageUrl: "https://images.unsplash.com/photo-1571068316344-75bc76f77890?w=1600",
      linkUrl: "/category/electric-bikes",
      buttonText: "Explore E-Bikes",
      placement: "hero",
      position: 1,
    },
    {
      eyebrow: "New Collection",
      title: "Mountain Bikes",
      imageUrl: "https://images.unsplash.com/photo-1532298229144-0ec0c57515c7?w=900",
      linkUrl: "/category/mountain-bikes",
      buttonText: "Shop Now",
      placement: "promo",
      position: 0,
    },
    {
      eyebrow: "Best Quality",
      title: "Speed Gear",
      imageUrl: "https://images.unsplash.com/photo-1511994298241-608e28f14fde?w=900",
      linkUrl: "/accessories",
      buttonText: "Shop Now",
      placement: "promo",
      position: 1,
    },
  ];
  let seededBanners = 0;
  if ((await prisma.banner.count()) === 0) {
    for (const b of BANNERS) {
      await prisma.banner.create({ data: { ...b, isActive: true } });
      seededBanners++;
    }
  }

  // Coupons (matching the storefront codes)
  const COUPONS: { code: string; type: "PERCENT" | "FIXED" | "FREE_SHIPPING"; value: number; description: string; minPurchase?: number; maxDiscount?: number }[] = [
    { code: "GET25OFF", type: "PERCENT", value: 25, description: "25% off your order", maxDiscount: 500 },
    { code: "SAVE50", type: "FIXED", value: 50, description: "₹50 off orders over ₹300", minPurchase: 300 },
    { code: "FREESHIP", type: "FREE_SHIPPING", value: 0, description: "Free shipping on your order" },
  ];
  for (const c of COUPONS) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      update: { type: c.type, value: c.value, description: c.description, minPurchase: c.minPurchase, maxDiscount: c.maxDiscount, isActive: true },
      create: { ...c, isActive: true },
    });
  }

  // Blog posts (mirrors the original storefront articles — same slugs so links stay valid)
  const bimg = (id: string, w = 1200) =>
    `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;
  const BLOG_POSTS: {
    slug: string; title: string; excerpt: string; content: string; coverUrl: string;
    category: string; author: string; tags: string[]; publishedAt: string;
  }[] = [
    {
      slug: "top-tips-first-long-distance-ride",
      title: "Top Tips For Your First Long Distance Ride",
      excerpt: "Planning your first century? Here's how to prepare your body, your bike and your mindset for the long haul.",
      content: [
        "Long-distance cycling is as much a mental challenge as a physical one. Before you set off on your first century ride, it pays to prepare properly — from fuelling your body to fine-tuning your bike.",
        "Start by building your base mileage gradually over several weeks. Sudden jumps in distance are the fastest route to injury and burnout. Aim to increase your weekly volume by no more than ten percent.",
        "Nutrition is critical. Eat a carbohydrate-rich meal the night before, and carry easily digestible snacks for the ride. Hydrate consistently rather than waiting until you feel thirsty.",
        "Finally, make sure your bike is dialled in. A professional fit, fresh tyres and a well-lubricated drivetrain will keep you comfortable and efficient for hours in the saddle.",
      ].join("\n\n"),
      coverUrl: bimg("1517649763962-0c623066013b"),
      category: "Cycling Tips", author: "Leslie Alexander",
      tags: ["Endurance", "Training", "Road"], publishedAt: "2025-08-12",
    },
    {
      slug: "how-to-keep-your-bike-in-perfect-shape",
      title: "How To Keep Your Bike In Perfect Shape",
      excerpt: "A simple maintenance routine that keeps your ride smooth, safe and lasting for years.",
      content: [
        "A well-maintained bike is a joy to ride and far cheaper to own. With just a few minutes of care each week, you can prevent most common mechanical problems.",
        "Keep your chain clean and lubricated — this is the single most impactful thing you can do. A dirty drivetrain wears out components quickly and robs you of efficiency.",
        "Check your tyre pressure before every ride, and inspect the tread and sidewalls for wear. Correct pressure improves grip, comfort and puncture resistance.",
        "Every few weeks, give the whole bike a wash, check your brake pads, and make sure all bolts are torqued correctly. When in doubt, book a service with our technicians.",
      ].join("\n\n"),
      coverUrl: bimg("1571068316344-75bc76f77890"),
      category: "Maintenance", author: "Michael Foster",
      tags: ["Maintenance", "DIY"], publishedAt: "2025-08-08",
    },
    {
      slug: "choosing-the-right-helmet-for-safety",
      title: "Choosing The Right Helmet For Safety",
      excerpt: "Not all helmets are created equal. Here's what to look for when protecting your most important asset.",
      content: [
        "Your helmet is the most important piece of safety equipment you own. Choosing the right one comes down to fit, certification and comfort.",
        "Always look for a recognised safety certification. A certified helmet has been tested to absorb impact and protect your head in a crash.",
        "Fit matters enormously. A helmet should sit level on your head, snug but not tight, with the straps forming a V under each ear. It should not rock forward or back.",
        "Finally, consider ventilation and weight for the type of riding you do. A well-ventilated helmet makes a huge difference on hot climbs and long rides.",
      ].join("\n\n"),
      coverUrl: bimg("1502744688674-c619d1586c9e"),
      category: "Gear Guide", author: "Dianne Russell",
      tags: ["Safety", "Gear"], publishedAt: "2025-08-01",
    },
    {
      slug: "exploring-the-best-mountain-trails",
      title: "Exploring The Best Mountain Trails",
      excerpt: "From flowing singletrack to technical descents, discover trails worth travelling for.",
      content: [
        "There's nothing quite like the thrill of discovering a new trail. Whether you crave flowing berms or gnarly rock gardens, the world is full of incredible riding.",
        "Before you head out, research the trail difficulty and make sure it matches your skill level. Many trail networks use a colour-coded grading system similar to ski runs.",
        "Pack the essentials: water, snacks, a multi-tool, spare tube and a mini pump. Cell coverage can be patchy in the mountains, so tell someone your plans.",
        "Most importantly, respect the trail and other users. Ride within your limits, yield to climbers and hikers, and leave no trace.",
      ].join("\n\n"),
      coverUrl: bimg("1576435728678-68d0fbf94e91"),
      category: "Adventure", author: "Guy Hawkins",
      tags: ["MTB", "Adventure", "Trails"], publishedAt: "2025-07-24",
    },
    {
      slug: "electric-bikes-explained",
      title: "Electric Bikes Explained: Are They Right For You?",
      excerpt: "E-bikes are transforming the way we commute and explore. Here's everything you need to know.",
      content: [
        "Electric bikes have surged in popularity — and for good reason. They flatten hills, shrink commutes and open up cycling to riders of all abilities.",
        "An e-bike provides assistance only while you pedal, amplifying your effort rather than replacing it. You still get exercise, just with a helpful boost.",
        "Consider your range needs, motor placement and battery capacity. A mid-drive motor offers a natural ride feel, while a hub motor is often more affordable.",
        "For commuters and adventurers alike, an e-bike can be a genuinely life-changing purchase. Book a test ride to feel the difference for yourself.",
      ].join("\n\n"),
      coverUrl: bimg("1571333250630-f0230c320b6d"),
      category: "Buying Guide", author: "Leslie Alexander",
      tags: ["E-Bike", "Commuting"], publishedAt: "2025-07-15",
    },
    {
      slug: "gear-up-for-winter-riding",
      title: "Gear Up For Winter Riding",
      excerpt: "Cold weather doesn't have to mean the end of the season. Stay warm, dry and visible.",
      content: [
        "Winter riding can be some of the most rewarding of the year — quiet roads, crisp air and a real sense of achievement. The key is the right gear.",
        "Layering is everything. A breathable base layer, an insulating mid layer and a windproof outer shell will keep you comfortable across a range of conditions.",
        "Don't forget your extremities. Warm gloves, overshoes and a headband under your helmet make a huge difference when temperatures drop.",
        "Visibility is crucial in low winter light. Run front and rear lights, and choose kit with reflective detailing to stay safe on the road.",
      ].join("\n\n"),
      coverUrl: bimg("1485965120184-e220f721d03e"),
      category: "Cycling Tips", author: "Michael Foster",
      tags: ["Winter", "Apparel"], publishedAt: "2025-07-02",
    },
  ];
  let seededPosts = 0;
  for (const [i, p] of BLOG_POSTS.entries()) {
    await prisma.blogPost.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        ...p,
        publishedAt: new Date(p.publishedAt),
        isPublished: true,
        isFeatured: i === 0,
        position: i,
      },
    });
    seededPosts++;
  }

  // Stores / showrooms (mirrors the original storefront branches).
  const simg = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=800&q=80`;
  const STORES = [
    {
      slug: "mathura-main-branch",
      name: "Agrawal Cycles — Main Branch",
      addressLine: "Best Cycle Shop, Mathura",
      city: "Mathura", state: "Uttar Pradesh", zip: "281001", country: "India",
      phone: "+91 90000 00000", email: "info@agrawalcycles.com",
      hours: "Mon–Sun: 10am–8pm",
      mapUrl: "https://maps.app.goo.gl/xoMnuBuYWvMqX6Vv6",
      imageUrl: simg("1571068316344-75bc76f77890"),
      lat: 27.515451, lng: 77.668925, position: 0,
    },
    {
      slug: "mathura-cycle-store",
      name: "Agrawal Cycle Store",
      addressLine: "Best Cycle Store, Mathura",
      city: "Mathura", state: "Uttar Pradesh", country: "India",
      phone: "+91 90000 00000",
      hours: "Mon–Sun: 10am–8pm",
      mapUrl: "https://share.google/asMUwuGdQGnLwxFfB",
      imageUrl: simg("1517649763962-0c623066013b"),
      position: 1,
    },
  ];
  let seededStores = 0;
  for (const s of STORES) {
    await prisma.store.upsert({
      where: { slug: s.slug },
      update: {},
      create: { ...s, isActive: true },
    });
    seededStores++;
  }

  // Team members (storefront "Meet the Team" on /about).
  const timg = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=400&q=80`;
  const TEAM = [
    { name: "Rahul Agrawal", designation: "Founder & Owner",
      bio: "Third-generation cyclist who turned a lifelong passion into Mathura's most trusted bicycle store.",
      photoUrl: timg("1500648767791-00dcc994a43e"), position: 0,
      socials: { linkedin: "https://linkedin.com", instagram: "https://instagram.com" } },
    { name: "Priya Sharma", designation: "Store Manager",
      bio: "Keeps the showroom running and every rider looked after, from first-timers to seasoned racers.",
      photoUrl: timg("1494790108377-be9c29b29330"), position: 1,
      socials: { linkedin: "https://linkedin.com" } },
    { name: "Vikram Singh", designation: "Head Mechanic",
      bio: "Twenty years on the workshop floor — there isn't a drivetrain he can't bring back to life.",
      photoUrl: timg("1547425260-76bcadfb4f2c"), position: 2,
      socials: {} },
  ];
  let seededTeam = 0;
  for (const m of TEAM) {
    const existing = await prisma.teamMember.findFirst({ where: { name: m.name, deletedAt: null } });
    if (!existing) {
      await prisma.teamMember.create({ data: { ...m, isVisible: true } });
      seededTeam++;
    }
  }

  // Sample admin notifications (only when the admin has none yet).
  let seededNotifs = 0;
  if ((await prisma.notification.count({ where: { userId: admin.id } })) === 0) {
    await prisma.notification.createMany({
      data: [
        { userId: admin.id, type: "system", title: "Welcome to Agrawal Cycles Admin", body: "Your dashboard is ready.", isRead: true },
        { userId: admin.id, type: "review", title: "New product review", body: "★★★★☆ on Trek Domane SL Road Bicycle", data: { href: "/admin/reviews" } },
        { userId: admin.id, type: "contact", title: "New contact message", body: "Priya Sharma — Bulk order enquiry", data: { href: "/admin/contact" } },
        { userId: admin.id, type: "order", title: "New order AC-DEMO-1001", body: "carol@example.com · INR 2,450", data: { href: "/admin/orders" } },
      ],
    });
    seededNotifs = 4;
  }

  console.log(
    `Seeded ${PRODUCTS.length} products, ${CATEGORIES.length} categories, ${ROLES.length} roles, ` +
      `${SETTINGS.length} setting groups, ${seededBanners} banners, ${COUPONS.length} coupons, ` +
      `${seededPosts} blog posts, ${seededStores} stores, ${seededTeam} team members, ${seededNotifs} notifications.`,
  );
  console.log(
    `Admin sign-in: Firebase only. Set ADMIN_BOOTSTRAP_EMAIL and sign in via the ` +
      `admin portal with that email to bootstrap super_admin (currently: ${bootstrapEmail}).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
