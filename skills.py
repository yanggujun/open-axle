"""
Skills module for AI Agent
This module provides a framework for adding custom skills/tools to the agent.
"""

from typing import Callable, Dict, Any, List
import json
import random
from datetime import datetime


class Skill:
    """Base class for agent skills."""
    
    def __init__(self, name: str, description: str, function: Callable):
        """
        Initialize a skill.
        
        Args:
            name: Skill name (unique identifier)
            description: Description of what the skill does
            function: The function that executes the skill
        """
        self.name = name
        self.description = description
        self.function = function
    
    def execute(self, *args, **kwargs) -> Any:
        """Execute the skill function."""
        return self.function(*args, **kwargs)
    
    def to_dict(self) -> Dict[str, str]:
        """Convert skill to dictionary format."""
        return {
            "name": self.name,
            "description": self.description
        }


class SkillManager:
    """Manages all skills available to the agent."""
    
    def __init__(self):
        """Initialize the skill manager."""
        self.skills: Dict[str, Skill] = {}
    
    def register_skill(self, skill: Skill):
        """
        Register a new skill.
        
        Args:
            skill: The skill to register
        """
        self.skills[skill.name] = skill
        print(f"✅ Skill registered: {skill.name}")
    
    def get_skill(self, name: str) -> Skill:
        """
        Get a skill by name.
        
        Args:
            name: Skill name
            
        Returns:
            The skill object
        """
        return self.skills.get(name)
    
    def list_skills(self) -> List[Dict[str, str]]:
        """
        List all available skills.
        
        Returns:
            List of skill information
        """
        return [skill.to_dict() for skill in self.skills.values()]
    
    def execute_skill(self, name: str, *args, **kwargs) -> Any:
        """
        Execute a skill by name.
        
        Args:
            name: Skill name
            *args: Positional arguments for the skill
            **kwargs: Keyword arguments for the skill
            
        Returns:
            Skill execution result
        """
        skill = self.get_skill(name)
        if skill:
            return skill.execute(*args, **kwargs)
        else:
            raise ValueError(f"Skill '{name}' not found")


# ============================================
# EXAMPLE SKILLS - Ready to use!
# ============================================

def skill_calculator(expression: str) -> str:
    """
    Calculate mathematical expressions.
    
    Args:
        expression: Math expression to evaluate (e.g., "2 + 2")
        
    Returns:
        Result of the calculation
    """
    try:
        # Safe evaluation (be careful in production!)
        result = eval(expression, {"__builtins__": {}}, {})
        return f"Result: {result}"
    except Exception as e:
        return f"Error calculating '{expression}': {str(e)}"


def skill_current_time() -> str:
    """
    Get the current date and time.
    
    Returns:
        Current date and time as string
    """
    now = datetime.now()
    return f"Current time: {now.strftime('%Y-%m-%d %H:%M:%S')}"


def skill_random_number(min_val: int = 1, max_val: int = 100) -> str:
    """
    Generate a random number.
    
    Args:
        min_val: Minimum value (default: 1)
        max_val: Maximum value (default: 100)
        
    Returns:
        Random number as string
    """
    number = random.randint(min_val, max_val)
    return f"Random number between {min_val} and {max_val}: {number}"


def skill_word_count(text: str) -> str:
    """
    Count words in text.
    
    Args:
        text: Text to analyze
        
    Returns:
        Word count information
    """
    words = text.split()
    chars = len(text)
    lines = text.count('\n') + 1
    
    return f"Words: {len(words)}, Characters: {chars}, Lines: {lines}"


def skill_reverse_text(text: str) -> str:
    """
    Reverse text.
    
    Args:
        text: Text to reverse
        
    Returns:
        Reversed text
    """
    return f"Reversed: {text[::-1]}"


def skill_to_uppercase(text: str) -> str:
    """
    Convert text to uppercase.
    
    Args:
        text: Text to convert
        
    Returns:
        Uppercase text
    """
    return text.upper()


def skill_to_lowercase(text: str) -> str:
    """
    Convert text to lowercase.
    
    Args:
        text: Text to convert
        
    Returns:
        Lowercase text
    """
    return text.lower()


def skill_json_format(data: str) -> str:
    """
    Format and validate JSON.
    
    Args:
        data: JSON string to format
        
    Returns:
        Formatted JSON or error message
    """
    try:
        obj = json.loads(data)
        formatted = json.dumps(obj, indent=2)
        return f"Formatted JSON:\n{formatted}"
    except Exception as e:
        return f"Invalid JSON: {str(e)}"


def skill_list_maker(items: str, separator: str = ",") -> str:
    """
    Create a formatted list from items.
    
    Args:
        items: Items separated by separator
        separator: Separator character (default: ",")
        
    Returns:
        Formatted list
    """
    item_list = [item.strip() for item in items.split(separator)]
    formatted = "\n".join([f"{i+1}. {item}" for i, item in enumerate(item_list)])
    return f"Formatted list:\n{formatted}"


def skill_temperature_converter(temp: float, from_unit: str = "C", to_unit: str = "F") -> str:
    """
    Convert temperature between Celsius and Fahrenheit.
    
    Args:
        temp: Temperature value
        from_unit: Source unit ('C' or 'F')
        to_unit: Target unit ('C' or 'F')
        
    Returns:
        Converted temperature
    """
    if from_unit.upper() == "C" and to_unit.upper() == "F":
        result = (temp * 9/5) + 32
        return f"{temp}°C = {result:.2f}°F"
    elif from_unit.upper() == "F" and to_unit.upper() == "C":
        result = (temp - 32) * 5/9
        return f"{temp}°F = {result:.2f}°C"
    else:
        return "Please use 'C' for Celsius or 'F' for Fahrenheit"


# ============================================
# Initialize default skills
# ============================================

def create_default_skill_manager() -> SkillManager:
    """
    Create a skill manager with all default skills registered.
    
    Returns:
        SkillManager with default skills
    """
    manager = SkillManager()
    
    # Register all default skills
    manager.register_skill(Skill(
        name="calculator",
        description="Calculate mathematical expressions (e.g., '2 + 2', '10 * 5')",
        function=skill_calculator
    ))
    
    manager.register_skill(Skill(
        name="current_time",
        description="Get the current date and time",
        function=skill_current_time
    ))
    
    manager.register_skill(Skill(
        name="random_number",
        description="Generate a random number (optionally specify min and max)",
        function=skill_random_number
    ))
    
    manager.register_skill(Skill(
        name="word_count",
        description="Count words, characters, and lines in text",
        function=skill_word_count
    ))
    
    manager.register_skill(Skill(
        name="reverse_text",
        description="Reverse any text",
        function=skill_reverse_text
    ))
    
    manager.register_skill(Skill(
        name="uppercase",
        description="Convert text to uppercase",
        function=skill_to_uppercase
    ))
    
    manager.register_skill(Skill(
        name="lowercase",
        description="Convert text to lowercase",
        function=skill_to_lowercase
    ))
    
    manager.register_skill(Skill(
        name="json_format",
        description="Format and validate JSON data",
        function=skill_json_format
    ))
    
    manager.register_skill(Skill(
        name="list_maker",
        description="Create a formatted numbered list from comma-separated items",
        function=skill_list_maker
    ))
    
    manager.register_skill(Skill(
        name="temp_converter",
        description="Convert temperature between Celsius and Fahrenheit",
        function=skill_temperature_converter
    ))
    
    return manager