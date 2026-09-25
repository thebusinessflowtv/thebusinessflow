import collect_visual_assets_hq as core


# Timely product episodes can need a wider historical visual pool than the exact
# newly-announced product name can provide on reusable-license sources. Keep the
# subject tightly scoped to Meta's VR/XR ecosystem while allowing the factory to
# reach its 40-image minimum without falling back to unrelated imagery.
core.SUBJECT_PROFILES.setdefault(
    "meta vr glasses",
    {
        "queries": [
            "Meta Quest 3 virtual reality headset",
            "Meta Quest 2 virtual reality headset",
            "Meta Quest Pro virtual reality headset",
            "Oculus Quest virtual reality headset",
            "Oculus Rift virtual reality headset",
            "Meta Reality Labs virtual reality",
            "Mark Zuckerberg Meta Quest",
            "Mark Zuckerberg virtual reality",
            "Meta headquarters Menlo Park",
            "Meta Connect virtual reality",
            "Ray-Ban Meta smart glasses",
            "Meta VR headset",
            "Facebook Oculus virtual reality",
            "Meta Quest gaming",
            "Meta Quest mixed reality passthrough",
        ],
        "allow_terms": {
            "meta", "quest", "oculus", "zuckerberg", "virtual reality", "vr",
            "mixed reality", "reality labs", "ray-ban meta", "meta connect",
        },
        "block_terms": {
            "metaverse stock image", "ai generated", "concept render",
        },
    },
)


# Income-comparison episodes need both sides of the job story represented. Use
# branded Amazon/DSP imagery where reusable sources provide it, then broaden to
# truthful last-mile delivery and U.S. trucking B-roll so the 40-image quality
# floor can be reached without lowering the 1080p source requirement.
core.SUBJECT_PROFILES.setdefault(
    "amazon drivers and us truckers",
    {
        "queries": [
            "Amazon delivery driver van",
            "Amazon DSP delivery driver",
            "Amazon Rivian delivery van",
            "Amazon package delivery driver",
            "Amazon delivery station vans",
            "Amazon logistics delivery van",
            "Amazon semi truck",
            "Amazon freight truck",
            "package delivery van driver",
            "last mile delivery driver van",
            "courier loading delivery van packages",
            "delivery vans distribution center",
            "package delivery warehouse loading",
            "cargo van parcel delivery",
            "logistics distribution center trucks",
            "parcel courier van United States",
            "delivery driver packages United States",
            "commercial delivery van street",
            "warehouse loading dock delivery vans",
            "distribution center loading dock trucks",
            "United States semi truck highway",
            "American long haul truck driver",
            "tractor trailer truck driver USA",
            "CDL truck driver United States",
            "truck stop semi trucks United States",
            "interstate highway semi truck",
            "long haul trucking United States",
            "18 wheeler American highway",
            "eighteen wheeler interstate highway",
            "freight truck loading dock",
            "semi truck cab interior driver",
            "commercial truck driver highway",
            "tractor trailer logistics terminal",
            "freight trucking distribution center",
            "semi trailers truck stop",
            "diesel semi truck interstate",
            "semi truck fleet parking",
            "truck driver rest area",
            "tractor trailer warehouse dock",
            "freight terminal semi trailers",
            "commercial trucking fleet United States",
            "semi truck cab highway",
            "tractor trailer interstate road",
            "truck stop parking lot semi",
        ],
        "allow_terms": {
            "amazon", "delivery", "driver", "delivery driver", "delivery van", "van", "courier", "parcel",
            "package", "cargo van", "warehouse", "distribution", "distribution center", "logistics", "shipping",
            "transport", "transportation", "fleet", "terminal", "rivian", "dsp", "road", "highway",
            "semi", "semi truck", "semi-trailer", "truck", "truck driver", "trucker", "tractor", "tractor trailer",
            "trailer", "tractor-trailer", "18 wheeler", "18-wheeler", "eighteen wheeler", "cdl", "long haul",
            "long-haul", "freight", "freight truck", "truck stop", "rest area", "loading dock", "interstate",
            "commercial", "commercial vehicle", "cab", "diesel",
        },
        "block_terms": {
            "logo", "logos", "stock chart", "ecommerce icon", "shopping cart icon",
            "ai generated", "concept render", "toy truck", "model truck",
        },
    },
)


# The September 2026 batch contains ranking/list episodes where requiring the
# entire episode title to appear in every image filename is far too strict. The
# profiles below keep the images factual and on-theme while allowing reusable
# 1080p+ B-roll from the actual companies, industries and infrastructure being
# discussed. The HQ collector still enforces license, uniqueness, landscape
# framing and 1080p source minimum, then normalizes every accepted image to 4K.

def add_profile(topic, queries, allow_terms, block_terms=None):
    core.SUBJECT_PROFILES.setdefault(
        topic.lower(),
        {
            "queries": queries,
            "allow_terms": set(allow_terms),
            "block_terms": set(block_terms or {"ai generated", "concept render", "illustration"}),
        },
    )


BIG_TECH_QUERIES = [
    "Apple Park Cupertino aerial",
    "Apple Store United States",
    "Microsoft campus Redmond",
    "Microsoft data center",
    "NVIDIA headquarters Santa Clara",
    "NVIDIA GPU graphics card",
    "Amazon headquarters Seattle",
    "Amazon fulfillment center",
    "Alphabet Googleplex Mountain View",
    "Google data center server",
    "Meta headquarters Menlo Park",
    "Meta data center",
    "Tesla Gigafactory Texas",
    "Tesla Supercharger station",
    "Walmart store United States",
    "Walmart distribution center",
    "Berkshire Hathaway Omaha",
    "JPMorgan Chase headquarters",
    "ExxonMobil refinery United States",
    "Visa payment card terminal",
    "Mastercard payment card terminal",
    "Broadcom semiconductor chip",
    "Oracle data center",
    "Costco warehouse United States",
]

BIG_TECH_TERMS = {
    "apple", "cupertino", "iphone", "mac", "microsoft", "redmond", "windows", "azure",
    "nvidia", "gpu", "graphics card", "amazon", "fulfillment", "warehouse", "google", "alphabet",
    "googleplex", "data center", "server", "meta", "facebook", "tesla", "gigafactory", "supercharger",
    "walmart", "berkshire", "omaha", "jpmorgan", "chase", "exxon", "refinery", "visa", "mastercard",
    "broadcom", "semiconductor", "chip", "oracle", "costco", "cloud", "technology", "factory",
}

add_profile(
    "10 American Billion-Dollar Companies",
    BIG_TECH_QUERIES + [
        "New York Stock Exchange trading floor",
        "Wall Street New York financial district",
        "United States corporate headquarters skyline",
    ],
    BIG_TECH_TERMS | {"stock exchange", "wall street", "financial district", "corporate"},
)

add_profile(
    "5 Most Valuable U.S. Companies in 2026",
    BIG_TECH_QUERIES[:16] + [
        "AI data center servers",
        "cloud computing data center",
        "semiconductor wafer fabrication",
        "smartphone manufacturing factory",
    ],
    BIG_TECH_TERMS | {"ai", "wafer", "smartphone", "manufacturing"},
)

add_profile(
    "5 U.S. Market-Shaping Companies",
    BIG_TECH_QUERIES + [
        "container port United States logistics",
        "cloud computing server racks",
        "semiconductor fabrication cleanroom",
        "payment terminal credit card",
        "ecommerce distribution warehouse",
    ],
    BIG_TECH_TERMS | {"port", "logistics", "server rack", "cleanroom", "payment", "ecommerce", "distribution"},
)

add_profile(
    "3 American Companies at the Top of the World in 2026",
    BIG_TECH_QUERIES[:15] + [
        "New York Stock Exchange exterior",
        "NASDAQ Times Square",
        "AI server rack data center",
        "smartphone production line",
    ],
    BIG_TECH_TERMS | {"nasdaq", "stock exchange", "ai", "production line"},
)

add_profile(
    "America's Richest Companies in 2026",
    BIG_TECH_QUERIES + [
        "New York Stock Exchange trading floor",
        "corporate earnings financial district",
        "oil refinery United States",
        "retail warehouse United States",
        "bank headquarters United States",
    ],
    BIG_TECH_TERMS | {"earnings", "financial", "oil", "retail", "bank"},
)

add_profile(
    "15 U.S. Industries Moving Billions",
    [
        "semiconductor fabrication cleanroom",
        "data center server racks United States",
        "automobile factory assembly line United States",
        "oil refinery United States",
        "natural gas pipeline United States",
        "pharmaceutical manufacturing United States",
        "hospital medical equipment United States",
        "commercial aircraft factory United States",
        "container port cargo United States",
        "freight train United States",
        "semi trucks logistics terminal United States",
        "warehouse distribution center United States",
        "construction cranes city United States",
        "commercial bank financial district United States",
        "credit card payment terminal",
        "retail supermarket United States",
        "ecommerce warehouse packages",
        "farm agriculture machinery United States",
        "wind farm United States",
        "solar farm United States",
        "telecommunications tower United States",
        "film studio Hollywood production",
        "hotel resort United States",
        "restaurant kitchen United States",
        "defense aerospace factory United States",
        "chemical plant United States",
        "steel mill United States",
        "food processing factory United States",
    ],
    {
        "semiconductor", "cleanroom", "data center", "server", "automobile", "assembly line", "refinery",
        "pipeline", "pharmaceutical", "hospital", "medical", "aircraft", "container", "port", "cargo",
        "freight", "train", "truck", "logistics", "warehouse", "construction", "crane", "bank", "financial",
        "payment", "retail", "supermarket", "ecommerce", "farm", "agriculture", "wind", "solar",
        "telecommunication", "tower", "hollywood", "studio", "hotel", "restaurant", "aerospace", "defense",
        "chemical", "steel", "mill", "food processing", "factory", "industry", "manufacturing",
    },
)

add_profile(
    "5 Companies Behind Global Infrastructure",
    [
        "Microsoft Azure data center",
        "Amazon Web Services data center",
        "Google cloud data center",
        "NVIDIA data center GPU",
        "Broadcom network switch semiconductor",
        "Cisco network switch data center",
        "Visa payment terminal",
        "Mastercard payment terminal",
        "Maersk container ship port",
        "FedEx cargo aircraft hub",
        "UPS logistics sorting facility",
        "semiconductor wafer fabrication cleanroom",
        "fiber optic cable data center",
        "submarine internet cable landing station",
        "server racks cloud computing",
        "container port cranes cargo",
        "global logistics warehouse",
        "telecommunications network equipment",
        "satellite ground station communications",
        "payment processing terminal",
    ],
    {
        "microsoft", "azure", "amazon", "aws", "google", "cloud", "nvidia", "gpu", "broadcom", "cisco",
        "network", "switch", "visa", "mastercard", "payment", "maersk", "container", "ship", "port", "fedex",
        "ups", "logistics", "semiconductor", "wafer", "fiber optic", "cable", "server", "data center",
        "telecommunication", "satellite", "infrastructure", "communications", "warehouse",
    },
)

add_profile(
    "America's Richest Family in 2026",
    [
        "Walton family Walmart",
        "Sam Walton Walmart",
        "Walmart store United States",
        "Walmart Supercenter United States",
        "Walmart distribution center",
        "Walmart truck distribution",
        "Walmart Bentonville Arkansas",
        "Walmart headquarters Bentonville",
        "retail warehouse United States",
        "supermarket checkout United States",
        "retail distribution warehouse",
        "Bentonville Arkansas downtown",
        "Koch Industries facility",
        "Mars Incorporated factory",
        "family business United States retail",
    ],
    {
        "walton", "walmart", "sam walton", "bentonville", "retail", "supercenter", "distribution", "warehouse",
        "supermarket", "koch", "mars", "family business", "arkansas", "store", "truck",
    },
)

add_profile(
    "NVIDIA",
    [
        "NVIDIA headquarters Santa Clara",
        "NVIDIA GPU graphics card",
        "NVIDIA GeForce graphics card",
        "NVIDIA DGX server",
        "Jensen Huang NVIDIA",
        "NVIDIA GTC Jensen Huang",
        "AI data center GPU servers",
        "data center server racks",
        "semiconductor wafer fabrication cleanroom",
        "silicon wafer semiconductor",
        "graphics processing unit circuit board",
        "high performance computing server",
        "machine learning data center",
        "supercomputer server racks",
        "semiconductor chip manufacturing",
        "computer graphics workstation",
        "AI accelerator server",
        "cloud data center servers",
    ],
    {
        "nvidia", "geforce", "gpu", "graphics", "jensen huang", "dgx", "gtc", "ai", "data center", "server",
        "semiconductor", "wafer", "silicon", "chip", "computing", "supercomputer", "machine learning", "accelerator",
    },
)

add_profile(
    "Google",
    [
        "Googleplex Mountain View",
        "Google headquarters Mountain View",
        "Alphabet headquarters California",
        "Sundar Pichai Google",
        "Google data center",
        "Google cloud data center",
        "Google search computer",
        "YouTube headquarters California",
        "Android smartphone Google",
        "Google Maps smartphone",
        "Google advertising office",
        "server racks data center",
        "cloud computing servers",
        "internet advertising computer",
        "Google campus bicycle",
        "Google office New York",
        "Google DeepMind office",
        "AI data center servers",
    ],
    {
        "google", "alphabet", "googleplex", "sundar pichai", "youtube", "android", "maps", "search", "advertising",
        "data center", "server", "cloud", "internet", "deepmind", "ai", "mountain view",
    },
)

add_profile(
    "Broadcom",
    [
        "Broadcom headquarters California",
        "Broadcom semiconductor chip",
        "Broadcom networking chip",
        "Broadcom office building",
        "VMware headquarters California",
        "VMware office building",
        "VMware data center software",
        "semiconductor wafer fabrication cleanroom",
        "silicon wafer semiconductor",
        "network switch data center",
        "ethernet switch server rack",
        "fiber optic network equipment",
        "data center server racks",
        "AI data center networking",
        "wireless communications chip",
        "telecommunications network equipment",
        "server networking hardware",
        "semiconductor manufacturing cleanroom",
        "printed circuit board network hardware",
        "cloud data center servers",
        "networking cables server rack",
        "high speed ethernet data center",
    ],
    {
        "broadcom", "vmware", "semiconductor", "chip", "wafer", "silicon", "network", "networking", "ethernet",
        "switch", "server", "data center", "fiber optic", "wireless", "telecommunication", "circuit board", "cloud",
        "hardware", "cleanroom", "communications",
    },
)


if __name__ == "__main__":
    core.main()
