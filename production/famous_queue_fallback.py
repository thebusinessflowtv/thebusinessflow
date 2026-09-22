from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOPICS = ROOT / 'production' / 'topics.json'

SEEDS = [
    ('Amazon','How Amazon Really Makes Money','AMAZON MACHINE',100,'retail/cloud/ads'),
    ('Tesla','How Tesla Built a Business Bigger Than Cars','TESLA MACHINE',99,'automotive/energy/software'),
    ('Apple','Why Apple Is So Hard to Compete With','APPLE MOAT',98,'ecosystem/services'),
    ('Coca-Cola','How Coca-Cola Built One of the World’s Most Powerful Distribution Machines','COKE MACHINE',97,'beverages/distribution'),
    ('Meta','How Meta Turns Attention Into Billions','META MONEY',96,'social media/advertising'),
    ('SpaceX','How SpaceX Changed the Economics of Space','SPACEX ECONOMICS',95,'space/launch'),
    ('Microsoft','How Microsoft Quietly Became a Cloud Giant','MICROSOFT CLOUD',94,'software/cloud'),
    ('Google','How Google Turned Search Into a Money Machine','GOOGLE MACHINE',93,'search/advertising'),
    ('Nvidia','How Nvidia Became the Tollbooth of the AI Boom','AI TOLLBOOTH',92,'chips/AI'),
    ('Walmart','How Walmart Built America’s Most Ruthless Supply Chain','WALMART SCALE',91,'retail/logistics'),
    ('McDonald’s','Why McDonald’s Is More Than a Burger Company','MCDONALD’S MONEY',90,'restaurants/real estate/franchising'),
    ('Costco','Why Costco’s Business Model Is So Hard to Copy','COSTCO MODEL',89,'retail/membership'),
    ('Disney','How Disney Turned Characters Into an Empire','DISNEY EMPIRE',88,'media/licensing/parks'),
    ('Netflix','How Netflix Rewired Hollywood','NETFLIX MACHINE',87,'streaming/media'),
    ('Nike','How Nike Turned Branding Into a Moat','NIKE MOAT',86,'apparel/branding'),
    ('Starbucks','How Starbucks Sold the World a Daily Habit','STARBUCKS HABIT',85,'coffee/retail'),
    ('PepsiCo','The Hidden Business Behind PepsiCo’s Snack Empire','PEPSICO EMPIRE',84,'food/beverage'),
    ('Uber','How Uber Finally Made Its Business Model Work','UBER ECONOMICS',83,'mobility/platform'),
    ('Airbnb','How Airbnb Built a Hotel Empire Without Owning Hotels','NO HOTELS',82,'travel/platform'),
    ('Boeing','How Boeing Lost Its Reputation','BOEING CRISIS',81,'aerospace'),
    ('Ford','How Ford Keeps Reinventing the American Car Business','FORD MACHINE',80,'automotive'),
    ('General Motors','How GM Became an American Industrial Giant','GM SCALE',79,'automotive'),
    ('Visa','How Visa Makes Money Without Lending You Money','VISA MACHINE',78,'payments'),
    ('Mastercard','How Mastercard Became a Global Payments Tollbooth','PAYMENT TOLL',77,'payments'),
    ('JPMorgan Chase','How JPMorgan Became America’s Banking Giant','BANKING GIANT',76,'banking'),
    ('Goldman Sachs','How Goldman Sachs Makes Money','GOLDMAN MONEY',75,'finance'),
    ('PayPal','How PayPal Changed Online Payments','PAYPAL MACHINE',74,'payments/fintech'),
    ('eBay','How eBay Lost Its Early Internet Advantage','EBAY LOST IT',73,'marketplace'),
    ('Intel','How Intel Lost Its Chip Lead','INTEL FALL',72,'semiconductors'),
    ('AMD','How AMD Came Back From the Edge','AMD COMEBACK',71,'semiconductors'),
    ('Samsung','How Samsung Became a Global Electronics Empire','SAMSUNG EMPIRE',70,'electronics'),
    ('Sony','How Sony Built a Business Around Hits and Hardware','SONY MACHINE',69,'electronics/media'),
    ('Toyota','How Toyota Built the World’s Most Famous Production System','TOYOTA SYSTEM',68,'automotive/manufacturing'),
    ('Ferrari','Why Ferrari Sells So Few Cars on Purpose','SCARCITY WINS',67,'luxury/automotive'),
    ('Adidas','How Adidas Competes With Nike','ADIDAS VS NIKE',66,'apparel'),
    ('Target','Why Target Looks Different From Walmart','TARGET MODEL',65,'retail'),
    ('Home Depot','How Home Depot Built a Retail Fortress','RETAIL FORTRESS',64,'retail/home improvement'),
    ('IKEA','How IKEA Engineered Low Prices at Massive Scale','IKEA SYSTEM',63,'furniture/retail'),
    ('LVMH','How LVMH Built the World’s Luxury Empire','LUXURY EMPIRE',62,'luxury'),
    ('Rolex','Why Rolex Controls Scarcity So Carefully','ROLEX SCARCITY',61,'luxury/watches'),
    ('Red Bull','How Red Bull Became a Media Company That Sells Drinks','MEDIA OR DRINKS?',60,'beverage/media'),
    ('Domino’s','How Domino’s Turned Pizza Into a Technology Business','PIZZA TECH',59,'restaurants/technology'),
    ('KFC','How KFC Became a Global Fast-Food Machine','KFC MACHINE',58,'restaurants/franchising'),
    ('Burger King','How Burger King Competes With McDonald’s','BURGER WAR',57,'restaurants'),
    ('Chipotle','How Chipotle Scaled Fast Casual','CHIPOTLE SCALE',56,'restaurants'),
    ('DoorDash','How DoorDash Won the Delivery War','DELIVERY WAR',55,'delivery/platform'),
    ('Spotify','How Spotify Built the World’s Music Subscription Machine','SPOTIFY MONEY',54,'music/streaming'),
    ('TikTok','How TikTok Turned Attention Into a Business','TIKTOK MACHINE',53,'social media'),
    ('X','What Elon Musk Is Trying to Build With X','THE EVERYTHING APP',52,'social media/payments'),
    ('xAI','How Elon Musk Is Trying to Build an AI Giant Fast','XAI RACE',51,'AI'),
]


def main() -> None:
    old = json.loads(TOPICS.read_text(encoding='utf-8')) if TOPICS.exists() else {}
    now = datetime.now(timezone.utc).isoformat()
    used = [t for t in old.get('topics', []) if t.get('status') in {'used','rendered_pending_manual_upload'}]
    topics = []
    for i,(company,title,thumb,score,category) in enumerate(SEEDS,1):
        topics.append({
            'id': f'famous-{i:03d}',
            'topic': company,
            'category': category,
            'working_angle': title,
            'title_seed': title,
            'thumbnail_text_seed': thumb,
            'status': 'ready',
            'click_score': score,
            'click_reason': 'Deterministic famous-company fallback; brand recognition prioritized.',
            'scored_at': now,
        })
    old['topics'] = topics + used
    old['reservoir'] = {
        'target_ready': 50,
        'ready_count': 50,
        'last_refreshed_at': now,
        'ranking': 'famous_company_fallback',
        'anthropic_optional_optimizer': True,
    }
    TOPICS.write_text(json.dumps(old, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('ready_topics=50')
    print('top_topic=Amazon')


if __name__ == '__main__':
    main()
