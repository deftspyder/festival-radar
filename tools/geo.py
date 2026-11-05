"""Add lat/lng (city level) to every entry in festivals.json that lacks them.

Distances on the site are straight-line from each member's home city, so every
festival and show needs a map point. This uses the offline GeoNames city list
(pip install geonamescache), plus PLACES below for small towns and festival
sites that aren't in it. Run: python3 tools/geo.py [festivals.json]
Prints any city it can't place; add those to PLACES (city as written in the
"city" field) and run it again.
"""
import json, math, sys, unicodedata
import geonamescache

# Small towns and sites missing from the GeoNames 15,000+ population list.
PLACES = {
    'George, WA': (47.0790, -119.8556),          # Gorge Amphitheatre area
    'Rothbury, MI': (43.5089, -86.3445),         # Double JJ Resort area
    'Clarks Grove, MN': (43.7633, -93.3291),
    'Daresbury, UK': (53.3400, -2.6330),
    'Somerset, UK': (51.1500, -2.5900),          # Worthy Farm, Pilton
    "Alpe d'Huez, France": (45.0920, 6.0690),
    'Lake Perris, CA': (33.8580, -117.1810),
    'Boom, Belgium': (51.0870, 4.3660),
    'George, Washington': (47.0790, -119.8556),
}
US_STATES = {'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'}
COUNTRY = {'UK': 'GB', 'England': 'GB', 'Scotland': 'GB', 'Germany': 'DE', 'Belgium': 'BE', 'Brazil': 'BR', 'France': 'FR', 'Mexico': 'MX',
           'Netherlands': 'NL', 'Spain': 'ES', 'Croatia': 'HR', 'Canada': 'CA', 'Australia': 'AU', 'Japan': 'JP', 'Thailand': 'TH', 'Portugal': 'PT', 'Italy': 'IT', 'Hungary': 'HU', 'Serbia': 'RS'}

def fold(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s.lower()) if unicodedata.category(c) != 'Mn').replace('.', '').strip()

_gc = geonamescache.GeonamesCache()
_cities = list(_gc.get_cities().values())

def place(city):
    city = (city or '').strip()
    if city in PLACES:
        return PLACES[city]
    parts = [p.strip() for p in city.split(',')]
    if len(parts) < 2:
        return None
    name, region = fold(parts[0]), parts[-1]
    if region in US_STATES:
        cc, admin = 'US', region
    else:
        cc, admin = COUNTRY.get(region), None
        if not cc:
            return None
    hits = [c for c in _cities if c['countrycode'] == cc and (admin is None or c['admin1code'] == admin)
            and (fold(c['name']) == name or name in [fold(a) for a in c.get('alternatenames', [])])]
    if not hits:
        return None
    best = max(hits, key=lambda c: c['population'])
    return (round(best['latitude'], 4), round(best['longitude'], 4))

def miles(a, b):
    r = 3958.8; p1, p2 = math.radians(a[0]), math.radians(b[0]); dp = p2 - p1; dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))

def main(path):
    d = json.load(open(path))
    missing = []
    for f in d['festivals']:
        if isinstance(f.get('lat'), (int, float)) and isinstance(f.get('lng'), (int, float)):
            continue
        p = place(f.get('city'))
        if p:
            f['lat'], f['lng'] = p
        else:
            missing.append(f.get('city'))
    open(path, 'w').write(json.dumps(d, indent=0, ensure_ascii=False) + '\n')
    if missing:
        print('Could not place:', sorted(set(missing)))
    return d

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'festivals.json')
