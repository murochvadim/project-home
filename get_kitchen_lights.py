#!/usr/bin/env python3
"""Query kitchen light switch states from Home Assistant"""

import requests

HASS_URL = "http://192.168.1.110:8123"
HASS_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI1NjFmNTlmY2U2NTE0ZTdkOTkxNWQ2YjFiZWE4ZTczMCIsImlhdCI6MTc3NDE4NTgyNywiZXhwIjoyMDg5NTQ1ODI3fQ.B6PMg6R3bu3L1OpV48Q3kk3VtZHHIlN9DbODJaJQ6aE"

HEADERS = {
    "Authorization": f"Bearer {HASS_TOKEN}",
    "Content-Type": "application/json",
}

def get_kitchen_lights():
    """Fetch states of kitchen light switches"""
    try:
        response = requests.get(f"{HASS_URL}/api/states", headers=HEADERS)
        response.raise_for_status()
        states = response.json()
        
        kitchen_lights = []
        for state in states:
            if state['entity_id'].startswith('switch.') and 'kitchen' in state['entity_id'].lower():
                kitchen_lights.append({
                    'entity_id': state['entity_id'],
                    'state': state['state'],
                    'friendly_name': state.get('attributes', {}).get('friendly_name', state['entity_id'])
                })
        
        return kitchen_lights
    except Exception as e:
        print(f"Error: {e}")
        return []

def turn_off_kitchen_lights():
    """Turn off all kitchen light switches"""
    try:
        # First get the states to find entity_ids
        response = requests.get(f"{HASS_URL}/api/states", headers=HEADERS)
        response.raise_for_status()
        states = response.json()
        
        kitchen_switches = []
        for state in states:
            if state['entity_id'].startswith('switch.') and 'kitchen' in state['entity_id'].lower():
                kitchen_switches.append(state['entity_id'])
        
        if kitchen_switches:
            # Turn off all
            turn_off_data = {"entity_id": kitchen_switches}
            response = requests.post(f"{HASS_URL}/api/services/switch/turn_off", headers=HEADERS, json=turn_off_data)
            response.raise_for_status()
            return True
        else:
            return False
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == 'turn_off':
        success = turn_off_kitchen_lights()
        if success:
            print("All kitchen light switches turned off.")
        else:
            print("Failed to turn off switches or no switches found.")
    else:
        lights = get_kitchen_lights()
        if lights:
            for light in lights:
                print(f"{light['friendly_name']}: {light['state']}")
        else:
            print("No kitchen light switches found or error retrieving data")